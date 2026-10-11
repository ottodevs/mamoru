import type { FeedbackRequest } from '@mamoru/domain'
import { useMutation } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { ApiRequestError, useApi } from '../api/client.ts'
import { Modal } from './ui.tsx'

// In-app feedback (otto/mamoru#72): one button, two paths. 'support' is read and answered in Mattermost, one
// thread per request. 'bug' and 'idea' are read weekly, in a batch. No third-party widget: the app sells privacy.

type Path = FeedbackRequest['kind']

export const feedbackCopy = {
  trigger: 'Help & feedback',
  title: 'Help & feedback',
  needHelp: 'I need help',
  haveFeedbackLead: 'I have feedback',
  bug: "Something's not working",
  idea: 'I have an idea',
  back: 'Back',
  bodyLabel: (path: Path) => (path === 'support' ? 'What do you need help with?' : path === 'bug' ? 'What went wrong?' : "What's your idea?"),
  bodyPlaceholder: 'Tell us what happened.',
  contactLabel: 'Contact (optional)',
  contactPlaceholder: 'Email, handle, or leave it blank',
  attachLabel: 'Attach my account so you can look into it',
  send: 'Send',
  sending: 'Sending',
  done: 'Done',
  doneBody: (path: Path) => (path === 'support' ? 'We read every request. If you left a contact, we answer there.' : 'Thank you. We read these every week.'),
  rateLimited: 'Too many requests. Wait a minute and try again.',
  genericError: 'Could not send. Try again.',
  bodyRequired: 'Say what happened.',
}

const BODY_MAX = 4000
const CONTACT_MAX = 200

function currentRoute(): string {
  if (typeof window === 'undefined' || !window.location.pathname.startsWith('/')) return '/'
  return window.location.pathname
}

/** The form for one path, once chosen. A pure function of its props: no step state of its own, so it is easy to render for a test. */
export function FeedbackForm({
  path,
  accountKey,
  busy,
  error,
  onBack,
  onSend,
}: {
  path: Path
  accountKey: string | undefined
  busy: boolean
  error: string | null
  onBack: () => void
  onSend: (fields: { body: string; contact: string; attachAccount: boolean; website: string }) => void
}) {
  const [body, setBody] = useState('')
  const [contact, setContact] = useState('')
  const [attach, setAttach] = useState(false)
  const [website, setWebsite] = useState('')
  const trimmed = body.trim()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (trimmed.length === 0) return
    onSend({ body: trimmed, contact: contact.trim(), attachAccount: attach, website })
  }
  return (
    <form className="grid gap-[0.6rem]" data-testid="feedback-form" onSubmit={submit}>
      {/* Honeypot: no person sees this field. A bot that fills every field fills this one too. */}
      <input
        type="text"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        name="website"
        autoComplete="off"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute h-0 w-0 opacity-0"
        style={{ left: '-9999px' }}
      />
      <label className="grid gap-[0.35rem] text-[0.88rem]">
        <span>{feedbackCopy.bodyLabel(path)}</span>
        <textarea className="field" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder={feedbackCopy.bodyPlaceholder} maxLength={BODY_MAX} />
      </label>
      <label className="grid gap-[0.35rem] text-[0.88rem]">
        <span>{feedbackCopy.contactLabel}</span>
        <input className="field" value={contact} onChange={(e) => setContact(e.target.value)} placeholder={feedbackCopy.contactPlaceholder} maxLength={CONTACT_MAX} autoComplete="off" />
      </label>
      <label className="flex items-center gap-2 text-[0.85rem]">
        <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} disabled={!accountKey} />
        {feedbackCopy.attachLabel}
      </label>
      {error ? <p className="err">{error}</p> : null}
      <div className="mt-1 flex justify-between">
        <button type="button" className="chipbtn" onClick={onBack}>
          {feedbackCopy.back}
        </button>
        <button type="submit" className="cta" disabled={busy || trimmed.length === 0}>
          {busy ? feedbackCopy.sending : feedbackCopy.send}
        </button>
      </div>
    </form>
  )
}

export function FeedbackDialog({ accountKey, open, onClose }: { accountKey: string | undefined; open: boolean; onClose: () => void }) {
  const api = useApi()
  const [path, setPath] = useState<Path | null>(null)
  const send = useMutation({ mutationFn: (body: FeedbackRequest) => api.feedback(body) })

  const close = () => {
    setPath(null)
    send.reset()
    onClose()
  }
  const error = send.error ? (send.error instanceof ApiRequestError && send.error.status === 429 ? feedbackCopy.rateLimited : feedbackCopy.genericError) : null

  return (
    <Modal open={open} onClose={close} title={feedbackCopy.title}>
      {send.isSuccess && path ? (
        <div className="grid gap-4" data-testid="feedback-done">
          <p className="m-0 text-[1.05rem]">{feedbackCopy.doneBody(path)}</p>
          <div className="flex justify-end">
            <button type="button" className="cta" onClick={close}>
              {feedbackCopy.done}
            </button>
          </div>
        </div>
      ) : path === null ? (
        <div className="grid gap-[0.6rem]" data-testid="feedback-pick">
          <button type="button" className="act" onClick={() => setPath('support')}>
            {feedbackCopy.needHelp}
          </button>
          <p className="m-0 mt-2 text-[0.85rem] text-stone">{feedbackCopy.haveFeedbackLead}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="act" onClick={() => setPath('bug')}>
              {feedbackCopy.bug}
            </button>
            <button type="button" className="act" onClick={() => setPath('idea')}>
              {feedbackCopy.idea}
            </button>
          </div>
        </div>
      ) : (
        <FeedbackForm
          path={path}
          accountKey={accountKey}
          busy={send.isPending}
          error={error}
          onBack={() => {
            send.reset()
            setPath(null)
          }}
          onSend={(fields) =>
            send.mutate({
              kind: path,
              body: fields.body,
              route: currentRoute(),
              attachAccount: fields.attachAccount,
              ...(fields.contact ? { contact: fields.contact } : {}),
              ...(fields.website ? { website: fields.website } : {}),
            })
          }
        />
      )}
    </Modal>
  )
}
