#[allow(dead_code)]
#[path = "../src-tauri/src/process.rs"]
mod process;
use std::{process::{Command,Stdio},time::{Duration,Instant},thread,io::Read};
fn command(kind: &str)->Command {
 let root=std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap());
 let mut c=Command::new(root.join(if kind=="powershell" {"System32/WindowsPowerShell/v1.0/powershell.exe"}else if kind=="native-path" {r"System32\cmd.exe"}else{"System32/cmd.exe"}));
 match kind {"old"|"native-path"=>{c.args(["/D","/C","exit 7"]);},"split"=>{c.args(["/D","/C","exit","7"]);},_=>{c.args(["-NoProfile","-NonInteractive","-Command","exit 7"]);}}
 c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());c
}
fn main(){
 for kind in ["old","split","native-path","powershell"] {
  for owned in [false,true] {
   let mut c=command(kind);
   let(mut child,job)=if owned {let(c,j)=process::spawn_in_job(&mut c).unwrap();(c,Some(j))}else{(c.spawn().unwrap(),None)};
   let until=Instant::now()+Duration::from_secs(15);
   let status=loop{if let Some(s)=child.try_wait().unwrap(){break s;}assert!(Instant::now()<until,"bounded probe deadline");thread::sleep(Duration::from_millis(10));};
   let mut stderr=String::new();child.stderr.take().unwrap().read_to_string(&mut stderr).unwrap();println!("kind={kind} owned={owned} exit={:?} stderr={stderr:?}",status.code());drop(job);
  }
 }
}
