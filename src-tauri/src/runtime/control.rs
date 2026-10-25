//! Bounded primitives for the native-owned runtime control channel.
//!
//! A write acknowledgement means bytes reached the pipe, NOT that the runtime
//! accepted an operation. Rotation/configuration need a separate protocol ACK.
//! Killing/reaping the owned child must never acquire the writer's lock. After
//! a pipe timeout the supervisor must revoke this generation and drain/kill it;
//! it must not silently resend a possibly delivered mutation to a replacement.

use std::{
    io::{self, BufRead, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::Instant,
};

pub const MAX_CONTROL_LINE: usize = 1024 * 1024;
const OUTBOX_CAPACITY: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlError {
    Closed,
    Full,
    TooLarge,
    Timeout,
    Io,
}

struct Outgoing {
    bytes: Vec<u8>,
    ack: mpsc::Sender<Result<(), ControlError>>,
}

/// One fixed writer thread per owned child. No caller holds a pipe mutex while
/// it waits. Backpressure rejects admission before spawning any extra thread.
#[derive(Clone)]
pub struct ControlWriter {
    sender: SyncSender<Outgoing>,
    closed: Arc<AtomicBool>,
}

pub struct WriteReceipt(Receiver<Result<(), ControlError>>);

impl WriteReceipt {
    pub fn wait_until(self, deadline: Instant) -> Result<(), ControlError> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        self.0
            .recv_timeout(remaining)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => ControlError::Timeout,
                mpsc::RecvTimeoutError::Disconnected => ControlError::Closed,
            })?
    }
}

/// Retained by the supervisor until the owned child has been terminated. Drop
/// does not wait on an OS write. A replacement must wait for `is_finished()`;
/// repeated failed generations must not accumulate detached writer threads.
pub struct WriterTask(Option<JoinHandle<()>>);

impl WriterTask {
    pub fn is_finished(&self) -> bool {
        self.0.as_ref().is_none_or(JoinHandle::is_finished)
    }

    pub fn reap_if_finished(&mut self) -> bool {
        if !self.is_finished() {
            return false;
        }
        if let Some(thread) = self.0.take() {
            let _ = thread.join();
        }
        true
    }
}

impl ControlWriter {
    pub fn start<W: Write + Send + 'static>(mut pipe: W) -> (Self, WriterTask) {
        let (sender, receiver) = mpsc::sync_channel::<Outgoing>(OUTBOX_CAPACITY);
        let closed = Arc::new(AtomicBool::new(false));
        let child_closed = closed.clone();
        let task = thread::spawn(move || {
            while let Ok(outgoing) = receiver.recv() {
                let result = if child_closed.load(Ordering::Acquire) {
                    Err(ControlError::Closed)
                } else {
                    pipe.write_all(&outgoing.bytes)
                        .and_then(|()| pipe.flush())
                        .map_err(|_| ControlError::Io)
                };
                if result.is_err() {
                    child_closed.store(true, Ordering::Release);
                }
                let _ = outgoing.ack.send(result);
                if child_closed.load(Ordering::Acquire) {
                    while let Ok(pending) = receiver.try_recv() {
                        let _ = pending.ack.send(Err(ControlError::Closed));
                    }
                    break;
                }
            }
        });
        (Self { sender, closed }, WriterTask(Some(task)))
    }

    /// The caller serializes JSON before this boundary. Embedded literal LF is
    /// forbidden: one payload must never inject another control frame.
    pub fn try_enqueue(&self, mut json: Vec<u8>) -> Result<WriteReceipt, ControlError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(ControlError::Closed);
        }
        if json.is_empty() || json.len() >= MAX_CONTROL_LINE || json.contains(&b'\n') {
            return Err(ControlError::TooLarge);
        }
        json.push(b'\n');
        let (ack, receipt) = mpsc::channel();
        self.sender
            .try_send(Outgoing { bytes: json, ack })
            .map_err(|error| match error {
                TrySendError::Full(_) => ControlError::Full,
                TrySendError::Disconnected(_) => ControlError::Closed,
            })?;
        Ok(WriteReceipt(receipt))
    }

    /// Revokes queued/future writes immediately. A currently blocked OS write
    /// is released by terminating the owned child, independently of this call.
    pub fn revoke(&self) {
        self.closed.store(true, Ordering::Release);
        // Wake an idle receiver as well. The flag is checked before any write,
        // so this sentinel can never reach the child's control channel.
        let (ack, _) = mpsc::channel();
        let _ = self.sender.try_send(Outgoing {
            bytes: Vec::new(),
            ack,
        });
    }
}

/// Bounded JSONL framing. `read_until`/`split` allocate the entire line before
/// a post-hoc limit; this function checks each BufRead slice BEFORE allocation.
pub fn read_control_line<R: BufRead>(reader: &mut R, line: &mut Vec<u8>) -> io::Result<bool> {
    line.clear();
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            return if line.is_empty() {
                Ok(false)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "unfinished control frame",
                ))
            };
        }
        let newline = bytes.iter().position(|byte| *byte == b'\n');
        let used = newline.map_or(bytes.len(), |at| at + 1);
        let payload = newline.unwrap_or(used);
        if line.len().saturating_add(payload) > MAX_CONTROL_LINE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "control frame too large",
            ));
        }
        line.extend_from_slice(&bytes[..payload]);
        reader.consume(used);
        if newline.is_some() {
            return Ok(true);
        }
    }
}

#[derive(Default)]
struct GateState {
    revoked: bool,
    admitted: usize,
}

/// Identity belongs to a single launch, never merely to a PID. Every reader,
/// activity update and broker task carries this same generation handle.
pub struct GenerationGate {
    pub generation: u64,
    state: Mutex<GateState>,
    drained: Condvar,
    limit: usize,
}

pub struct GenerationPermit(Arc<GenerationGate>);

impl GenerationGate {
    pub fn new(generation: u64, max_admitted: usize) -> Arc<Self> {
        assert!(max_admitted > 0);
        Arc::new(Self {
            generation,
            state: Mutex::new(GateState::default()),
            drained: Condvar::new(),
            limit: max_admitted,
        })
    }

    pub fn admit(self: &Arc<Self>) -> Result<GenerationPermit, ControlError> {
        let mut state = self.state.lock().map_err(|_| ControlError::Closed)?;
        if state.revoked {
            return Err(ControlError::Closed);
        }
        if state.admitted >= self.limit {
            return Err(ControlError::Full);
        }
        state.admitted += 1;
        Ok(GenerationPermit(self.clone()))
    }

    pub fn is_active(&self) -> bool {
        self.state.lock().is_ok_and(|state| !state.revoked)
    }

    pub fn revoke(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.revoked = true;
            self.drained.notify_all();
        }
    }

    pub fn wait_drained_until(&self, deadline: Instant) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        while state.admitted != 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let Ok((next, _)) = self.drained.wait_timeout(state, remaining) else {
                return false;
            };
            state = next;
        }
        true
    }
}

impl GenerationPermit {
    /// Check immediately before a side effect. Revoking a generation cannot
    /// undo an already admitted external operation; it remains in drain count
    /// until this permit is dropped, even if the response can no longer return.
    pub fn is_active(&self) -> bool {
        self.0.is_active()
    }
}

impl Drop for GenerationPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.state.lock() {
            state.admitted -= 1;
            if state.admitted == 0 {
                self.0.drained.notify_all();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};
    use std::time::Duration;

    fn until() -> Instant {
        Instant::now() + Duration::from_secs(2)
    }

    #[test]
    fn json_framing_does_not_split_unicode_separators_or_lose_following_frames() {
        let mut reader = BufReader::with_capacity(
            3,
            Cursor::new("{\"v\":\"a\u{2028}b\u{2029}c\"}\n{}\n".as_bytes()),
        );
        let mut line = Vec::new();
        assert!(read_control_line(&mut reader, &mut line).unwrap());
        assert_eq!(
            String::from_utf8(line.clone()).unwrap(),
            "{\"v\":\"a\u{2028}b\u{2029}c\"}"
        );
        assert!(read_control_line(&mut reader, &mut line).unwrap());
        assert_eq!(line, b"{}");
        assert!(!read_control_line(&mut reader, &mut line).unwrap());
    }

    #[test]
    fn oversized_unterminated_frame_stops_before_allocating_full_input() {
        let bytes = vec![b'x'; MAX_CONTROL_LINE * 3];
        let mut reader = BufReader::with_capacity(4096, Cursor::new(bytes));
        let mut line = Vec::new();
        let error = read_control_line(&mut reader, &mut line).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(line.len() <= MAX_CONTROL_LINE);
        assert!(reader.get_ref().position() <= (MAX_CONTROL_LINE + 4096) as u64);
    }

    #[test]
    fn incomplete_frame_and_exact_limit_have_explicit_outcomes() {
        let mut reader = Cursor::new(b"{}");
        assert_eq!(
            read_control_line(&mut reader, &mut Vec::new())
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
        let mut bytes = vec![b'x'; MAX_CONTROL_LINE];
        bytes.push(b'\n');
        let mut reader = Cursor::new(bytes);
        let mut line = Vec::new();
        assert!(read_control_line(&mut reader, &mut line).unwrap());
        assert_eq!(line.len(), MAX_CONTROL_LINE);
    }

    #[test]
    fn old_generation_remains_revoked_after_new_launch_and_accounts_inflight_work() {
        let old = GenerationGate::new(41, 2);
        let permit = old.admit().unwrap();
        let queued = old.admit().unwrap();
        assert!(matches!(old.admit(), Err(ControlError::Full)));
        old.revoke();
        let new = GenerationGate::new(42, 2);
        assert!(new.is_active());
        assert!(!permit.is_active());
        assert!(matches!(old.admit(), Err(ControlError::Closed)));
        assert!(!old.wait_drained_until(Instant::now()));
        drop(queued);
        assert!(!old.wait_drained_until(Instant::now()));
        drop(permit);
        assert!(old.wait_drained_until(until()));
    }

    #[test]
    fn drain_deadline_is_bounded_even_when_a_broker_operation_has_not_returned() {
        let gate = GenerationGate::new(1, 1);
        let permit = gate.admit().unwrap();
        gate.revoke();
        let started = Instant::now();
        assert!(!gate.wait_drained_until(started + Duration::from_millis(20)));
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(permit);
        assert!(gate.wait_drained_until(until()));
    }

    struct BlockedPipe {
        started: Option<mpsc::Sender<()>>,
        release: Receiver<()>,
    }

    impl Write for BlockedPipe {
        fn write(&mut self, _bytes: &[u8]) -> io::Result<usize> {
            if let Some(started) = self.started.take() {
                started.send(()).unwrap();
            }
            let _ = self.release.recv();
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "owned child terminated",
            ))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn blocked_os_write_cannot_block_revoke_or_supervisor_deadline() {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (writer, mut task) = ControlWriter::start(BlockedPipe {
            started: Some(started_tx),
            release: release_rx,
        });
        let receipt = writer.try_enqueue(b"{}".to_vec()).unwrap();
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let started = Instant::now();
        assert_eq!(
            receipt.wait_until(started + Duration::from_millis(20)),
            Err(ControlError::Timeout)
        );
        writer.revoke();
        assert!(matches!(
            writer.try_enqueue(b"{}".to_vec()),
            Err(ControlError::Closed)
        ));
        assert!(!task.is_finished());
        assert!(started.elapsed() < Duration::from_secs(1));
        // Model owned-child termination; the test always releases and joins.
        release_tx.send(()).unwrap();
        drop(writer);
        let deadline = until();
        while !task.is_finished() && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(task.reap_if_finished());
    }

    #[test]
    fn saturated_writer_rejects_extra_frames_without_extra_threads() {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (writer, mut task) = ControlWriter::start(BlockedPipe {
            started: Some(started_tx),
            release: release_rx,
        });
        let first = writer.try_enqueue(b"{}".to_vec()).unwrap();
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let receipts: Vec<_> = (0..OUTBOX_CAPACITY)
            .map(|_| writer.try_enqueue(b"{}".to_vec()).unwrap())
            .collect();
        assert!(matches!(
            writer.try_enqueue(b"{}".to_vec()),
            Err(ControlError::Full)
        ));
        writer.revoke();
        release_tx.send(()).unwrap();
        assert_eq!(first.wait_until(until()), Err(ControlError::Io));
        for receipt in receipts {
            assert_eq!(receipt.wait_until(until()), Err(ControlError::Closed));
        }
        drop(writer);
        let deadline = until();
        while !task.is_finished() && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(task.reap_if_finished());
    }

    #[test]
    fn encoder_boundary_rejects_injected_and_oversized_frames() {
        let (writer, mut task) = ControlWriter::start(Vec::<u8>::new());
        assert!(matches!(
            writer.try_enqueue(b"{}\n{}".to_vec()),
            Err(ControlError::TooLarge)
        ));
        assert!(matches!(
            writer.try_enqueue(vec![b'x'; MAX_CONTROL_LINE]),
            Err(ControlError::TooLarge)
        ));
        assert!(matches!(
            writer.try_enqueue(Vec::new()),
            Err(ControlError::TooLarge)
        ));
        writer
            .try_enqueue(b"{}".to_vec())
            .unwrap()
            .wait_until(until())
            .unwrap();
        drop(writer);
        let deadline = until();
        while !task.is_finished() && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(task.reap_if_finished());
    }

    #[test]
    #[ignore = "owned fixture child; launched only by actual_pipe_timeout_and_kill_release"]
    fn never_read_stdin_child() {
        thread::sleep(Duration::from_secs(3));
    }

    #[test]
    fn actual_pipe_timeout_and_kill_release() {
        use std::process::{Child, Command, Stdio};
        struct OwnedChild(Child);
        impl Drop for OwnedChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut command = Command::new(std::env::current_exe().unwrap());
        let test_module = module_path!().split_once("::").expect("test module").1;
        let fixture_name = format!("{test_module}::never_read_stdin_child");
        command
            .args(["--ignored", "--exact", fixture_name.as_str()])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = OwnedChild(command.spawn().unwrap());
        let (writer, mut task) = ControlWriter::start(child.0.stdin.take().unwrap());
        let receipt = writer
            .try_enqueue(vec![b'x'; MAX_CONTROL_LINE - 1])
            .unwrap();
        let started = Instant::now();
        assert_eq!(
            receipt.wait_until(started + Duration::from_millis(40)),
            Err(ControlError::Timeout)
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        writer.revoke();
        assert!(!task.is_finished());
        // No writer lock is acquired by kill/reap. Only this test-owned PID is
        // signalled; the three-second fixture delay also bounds panic cleanup.
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        drop(writer);
        let deadline = until();
        while !task.is_finished() && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(task.reap_if_finished());
    }
}
