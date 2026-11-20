import Link from "next/link"
import type { ReactNode } from "react"
import { logout } from "@/app/actions"

export function Shell({ user, children }: { user: string; children: ReactNode }) {
  return (
    <>
      <header className="top">
        <Link href="/" className="brand">letterflow</Link>
        <Link href="/">Kampagnen</Link>
        <Link href="/settings">Systeme</Link>
        <form action={logout} className="row">
          <span className="muted">{user}</span>
          <button className="secondary" type="submit">Abmelden</button>
        </form>
      </header>
      <main>{children}</main>
    </>
  )
}
