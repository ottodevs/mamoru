import { ErrorNotice, Section } from '../components/section.tsx'
import { errors, GUIDE_URL, leave as copy } from '../copy/dashboard.ts'

export function LeavePanel({ onDownload, downloadState }: { onDownload: () => void; downloadState: 'idle' | 'pending' | 'error' }) {
  return (
    <Section id="leave" title="Leave without Mamoru" question="How do I leave or recover my funds without Mamoru?">
      <p className="m-0 leading-snug">{copy.body}</p>
      <p className="m-0 text-[0.9rem] text-stone">{copy.walk04}</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary" onClick={onDownload} disabled={downloadState === 'pending'}>
          {copy.download}
        </button>
        <a className="btn btn-ghost" href={GUIDE_URL} target="_blank" rel="noreferrer">
          {copy.guide}
        </a>
      </div>
      {downloadState === 'error' ? <ErrorNotice message={errors.kit} /> : null}
    </Section>
  )
}
