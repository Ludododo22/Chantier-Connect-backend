export function maskEmail(email: string | null) {
  if (!email) return null
  const [local, domain] = email.split("@")
  if (!domain) return "••••"
  const visible = local!.slice(0, 1)
  return `${visible}•••@${domain}`
}

export function maskPhone(phone: string | null) {
  if (!phone) return null
  const digits = phone.replace(/\D/g, "")
  const suffix = digits.slice(-2)
  const prefix = phone.startsWith("+") ? "+" : ""
  return `${prefix}${"•".repeat(Math.max(3, digits.length - suffix.length))}${suffix}`
}

export function maskSensitiveText(value: string) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email masqué]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[téléphone masqué]")
}
