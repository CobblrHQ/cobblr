// HTML-escape for text that lands inside an email template.
//
// Its own leaf module because both the email template and the routes that build
// one need it, and a platform module importing from a route would be backwards.

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
