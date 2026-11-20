import "server-only"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { readSessionToken, SESSION_COOKIE } from "@/lib/auth"

/** Angemeldete Person oder Umleitung zum Login. Der Name wird zum Akteur human:<name>. */
export async function requireUser() {
  const session = readSessionToken((await cookies()).get(SESSION_COOKIE)?.value)
  if (!session) redirect("/login")
  return session
}
