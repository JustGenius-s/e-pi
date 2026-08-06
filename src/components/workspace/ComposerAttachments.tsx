import { File, Sparkles, X } from "lucide-react";

import type { SkillRecord } from "../../types/contracts";

interface ComposerAttachmentsProps {
  files: string[];
  thumbnails: Record<string, string>;
  selectedSkill?: SkillRecord;
  onPreview: (path: string) => void;
  onRemoveFile: (path: string) => void;
  onRemoveSkill: () => void;
}

export function ComposerAttachments({
  files,
  thumbnails,
  selectedSkill,
  onPreview,
  onRemoveFile,
  onRemoveSkill,
}: ComposerAttachmentsProps) {
  if (files.length === 0 && !selectedSkill) return null;
  return (
    <div className="composer-attachments" aria-label="Attached context">
      {selectedSkill ? (
        <span className="composer-attachment composer-skill" title={selectedSkill.description}>
          <Sparkles size={12} />
          <span>{selectedSkill.name}</span>
          <button type="button" onClick={onRemoveSkill} aria-label={`Remove ${selectedSkill.name} skill`}>
            <X size={12} />
          </button>
        </span>
      ) : null}
      {files.map((path) => {
        const image = /\.(png|jpe?g|gif|webp|bmp)$/i.test(path);
        const thumb = image ? thumbnails[path] : undefined;
        return (
          <span className="composer-attachment" data-image={image ? "true" : undefined} key={path} title={path}>
            {image ? (
              <button
                type="button"
                className="composer-attachment-thumb"
                onClick={() => onPreview(path)}
                aria-label={`Preview ${path}`}
              >
                {thumb ? <img src={thumb} alt="" /> : <File size={14} />}
              </button>
            ) : (
              <File size={12} />
            )}
            {!image ? (
              <button type="button" className="composer-attachment-name" aria-label={path}>
                <span>{path.split(/[\\/]/).pop()}</span>
              </button>
            ) : null}
            <button type="button" onClick={() => onRemoveFile(path)} aria-label={`Remove ${path}`}>
              <X size={12} />
            </button>
          </span>
        );
      })}
    </div>
  );
}
