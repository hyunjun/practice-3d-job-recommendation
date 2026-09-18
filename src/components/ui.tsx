import { useEffect, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, Check, Globe2, X } from 'lucide-react'
import type { City, Company } from '../../shared/types'

export function OrbitLogo({ small = false }: { small?: boolean }) {
  return <span className={`orbit-logo ${small ? 'small' : ''}`} aria-hidden="true">
    <svg viewBox="0 0 48 48" fill="none">
      <circle cx="24" cy="24" r="11" stroke="currentColor" strokeWidth="1.7" />
      <ellipse cx="24" cy="24" rx="22" ry="7.5" transform="rotate(-42 24 24)" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="39.5" cy="9" r="2.4" fill="currentColor" />
    </svg>
  </span>
}

export function CompanyLogo({ company, small = false }: { company: Company; small?: boolean }) {
  return <span className={`company-logo logo-${company.id} ${small ? 'small' : ''}`} style={{ '--company-color': company.color } as CSSProperties} aria-hidden="true">{company.initials}</span>
}

export function CityImage({ city, className = '' }: { city: City; className?: string }) {
  return city.image
    ? <img className={`city-image ${className}`} src={`/cities/${city.image}.jpg`} alt="" loading="lazy" />
    : <span className={`city-image city-image-fallback ${className}`} aria-hidden="true"><Globe2 /><span>{city.en.slice(0, 3).toUpperCase()}</span></span>
}

export function Dialog({ title, eyebrow, children, onClose, className = '' }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const dialog = ref.current!
    const activeElement = document.activeElement as HTMLElement | null
    dialog.showModal()
    const before = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      dialog.close()
      document.body.style.overflow = before
      activeElement?.focus()
    }
  }, [])

  return createPortal(<dialog ref={ref} className={`dialog ${className}`} onCancel={event => { event.preventDefault(); closeRef.current() }} onClick={event => {
    if (event.target !== ref.current) return
    const rect = ref.current.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeRef.current()
  }} aria-labelledby="dialog-title">
    <header className="dialog-header">
      <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2 id="dialog-title">{title}</h2></div>
      <button className="icon-button dialog-close" aria-label="닫기" onClick={onClose}><X size={20} /></button>
    </header>
    {children}
  </dialog>, document.body)
}

export function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description?: string }) {
  return <label className="toggle-row">
    <span><span className="toggle-label">{label}</span>{description && <span className="field-description">{description}</span>}</span>
    <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
    <span className="toggle-track" aria-hidden="true"><span /></span>
  </label>
}

export function EmptyState({ icon, title, text, children }: { icon: ReactNode; title: string; text: string; children?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{text}</p>{children}</div>
}

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner-wrap" role="status"><span className="spinner" aria-hidden="true" />{label && <span>{label}</span>}</span>
}

export function Toast({ message, action, onDismiss }: { message: string; action?: { label: string; run: () => void }; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, action ? 7000 : 4500)
    return () => clearTimeout(timer)
  }, [message, onDismiss, action])
  return <div className="toast" role="status"><span className="toast-check"><Check size={15} /></span><span>{message}</span>{action && <button onClick={() => { action.run(); onDismiss() }}>{action.label}</button>}<button className="icon-button" onClick={onDismiss} aria-label="알림 닫기"><X size={15} /></button></div>
}

export function ExternalIcon() {
  return <ArrowUpRight size={15} aria-hidden="true" />
}
