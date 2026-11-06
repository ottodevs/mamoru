// <i-tip>: the app's (i) icon (components/ui.tsx) with a small panel; opens on hover or tap, closes on Escape or outside tap.
customElements.define('i-tip', class extends HTMLElement {
  connectedCallback() {
    if (this._ready) return
    this._ready = true
    const text = this.textContent.trim()
    this.textContent = ''
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('aria-label', 'How this is computed')
    b.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="6.3"/><path d="M8 7.3v4" stroke-linecap="round"/><circle cx="8" cy="4.6" r=".75" fill="currentColor" stroke="none"/></svg>'
    const p = document.createElement('span')
    p.className = 'panel'
    p.setAttribute('role', 'tooltip')
    p.textContent = text
    this.append(b, p)
    b.addEventListener('click', (e) => { e.stopPropagation(); this.toggleAttribute('open'); this.place() })
    b.addEventListener('mouseenter', () => { this.setAttribute('open', ''); this.place() })
    b.addEventListener('mouseleave', () => this.removeAttribute('open'))
    document.addEventListener('click', () => this.removeAttribute('open'))
    document.addEventListener('keydown', (e) => e.key === 'Escape' && this.removeAttribute('open'))
  }
  place() { this.classList.toggle('flip', this.getBoundingClientRect().left > innerWidth - 280) }
})

