import { useState } from 'react';
import { Paperclip, X, Film } from 'lucide-react';
import type { TaskAttachment } from '../types';

function assetUrl(localPath: string): string {
  return `/api/asset?path=${encodeURIComponent(localPath)}`;
}

/** Grid of thumbnails for image/video attachments (Jira-synced or uploaded); click to enlarge. */
export function AttachmentGrid({ attachments }: { attachments?: TaskAttachment[] }) {
  const [zoom, setZoom] = useState<TaskAttachment | null>(null);
  const media = (attachments ?? []).filter(a => a.mimeType?.startsWith('image/') || a.mimeType?.startsWith('video/'));
  if (media.length === 0) return null;

  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-slate-400 mb-2">
        <Paperclip size={11} /> Attachments ({media.length})
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {media.map((a, i) => {
          const isVideo = a.mimeType?.startsWith('video/');
          return (
            <button
              key={a.localPath || i}
              onClick={() => setZoom(a)}
              title={a.filename}
              className="group relative aspect-square rounded-lg overflow-hidden border border-slate-200 bg-slate-50 hover:border-violet-400 transition-colors"
            >
              {isVideo ? (
                <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-slate-400">
                  <Film size={20} />
                  <span className="text-[8px] px-1 truncate max-w-full">{a.filename}</span>
                </div>
              ) : (
                <img src={assetUrl(a.localPath)} alt={a.filename} className="w-full h-full object-cover" loading="lazy" />
              )}
              <span className="absolute inset-x-0 bottom-0 px-1 py-0.5 text-[9px] text-white bg-black/50 truncate opacity-0 group-hover:opacity-100 transition-opacity">
                {a.filename}
              </span>
            </button>
          );
        })}
      </div>

      {zoom && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-black/80 backdrop-blur-sm animate-fade-in"
          onClick={() => setZoom(null)}
        >
          <button className="absolute top-4 right-4 p-2 text-white/70 hover:text-white" onClick={() => setZoom(null)}>
            <X size={20} />
          </button>
          {zoom.mimeType?.startsWith('video/') ? (
            <video src={assetUrl(zoom.localPath)} controls autoPlay
              className="max-w-full max-h-full rounded-lg shadow-2xl" onClick={e => e.stopPropagation()} />
          ) : (
            <img src={assetUrl(zoom.localPath)} alt={zoom.filename}
              className="max-w-full max-h-full rounded-lg shadow-2xl" onClick={e => e.stopPropagation()} />
          )}
        </div>
      )}
    </div>
  );
}
