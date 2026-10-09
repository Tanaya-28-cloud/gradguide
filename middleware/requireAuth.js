export function requireAuth(req, res, next) {
  if (req.session?.counsellor?.id) return next();
  if (req.accepts("html") && !req.path.startsWith("/api/")) return res.redirect("/login.html");
  return res.status(401).json({ error: "Please log in to continue." });
}
