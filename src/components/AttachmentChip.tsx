import {useEffect,useState} from "react";
import {Icon} from "./Icon";
import type {DraftAttachment} from "../attachments/drafts";

export function AttachmentChip({ file, onRemove, disabled }: { file: DraftAttachment; onRemove: () => void; disabled: boolean }) {
  const [preview, setPreview] = useState("");
  useEffect(() => {
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mime)) return;
    const url = URL.createObjectURL(file.blob);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <div className={`attachment-chip ${preview ? "attachment-chip-image" : ""}`}>
    {preview ? <img src={preview} alt=""/> : <Icon name="file" size={18}/>}
    <span title={file.name}>{file.name}</span><small>{file.size < 1024 * 1024 ? `${Math.max(1, Math.ceil(file.size / 1024))} КБ` : `${(file.size / 1024 / 1024).toFixed(1)} МБ`}</small>
    <button type="button" disabled={disabled} aria-label={`Убрать ${file.name}`} onClick={onRemove}><Icon name="close" size={14}/></button>
  </div>;
}

