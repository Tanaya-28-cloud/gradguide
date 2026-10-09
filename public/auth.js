const $ = (s) => document.querySelector(s);
const page = document.body.dataset.page, form = $("#auth-form"), message = $("#form-message");
document.querySelectorAll("[data-year]").forEach((e) => e.textContent = new Date().getFullYear());
function showMessage(text, type = "error") { message.textContent = text; message.className = `form-message visible ${type}`; }
function clearMessage() { message.textContent = ""; message.className = "form-message"; }
document.querySelectorAll("[data-toggle-password]").forEach((b) => b.addEventListener("click", () => {
  const input = document.getElementById(b.dataset.togglePassword), show = input.type === "password";
  input.type = show ? "text" : "password"; b.textContent = show ? "Hide" : "Show";
}));
async function post(path, payload) {
  const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Something went wrong. Please try again.");
  return d;
}
(async () => { try { const r = await fetch("/api/auth/me", { credentials: "same-origin" }); if (r.ok) location.replace("/"); } catch {} })();
form.addEventListener("submit", async (e) => {
  e.preventDefault(); clearMessage();
  const button = form.querySelector('[type="submit"]'), label = button.querySelector("span:first-child");
  const old = label.textContent; button.disabled = true; label.textContent = page === "signup" ? "Creating account…" : "Signing in…";
  try {
    let result;
    if (page === "signup") {
      const fullName = $("#fullName").value.trim(), username = $("#username").value.trim();
      const email = $("#email").value.trim(), password = $("#password").value;
      if (password !== $("#confirmPassword").value) throw new Error("The passwords do not match.");
      if (password.length < 8) throw new Error("Use at least 8 characters for your password.");
      result = await post("/api/auth/signup", { fullName, username, email, password });
    } else {
      result = await post("/api/auth/login", { identifier: $("#identifier").value.trim(), password: $("#password").value });
    }
    showMessage(page === "signup" ? "Account created. Opening your workspace…" : "Signed in. Opening your workspace…", "success");
    setTimeout(() => location.replace("/"), 350);
  } catch (err) { showMessage(err.message || "Unable to sign in. Please try again."); button.disabled = false; label.textContent = old; }
});
