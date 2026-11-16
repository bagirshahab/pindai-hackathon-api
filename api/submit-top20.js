import { neon } from "@neondatabase/serverless";
import { Resend } from "resend";

const sql = neon(process.env.DATABASE_URL);
const resend = new Resend(process.env.RESEND_API_KEY);

// Email harus sudah diverifikasi OTP dalam rentang waktu ini (dihitung dari OTP dikirim).
const OTP_VALID_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 jam

function setCorsHeaders(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// <links-validation>
const REPO_HOSTS = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"];
const GITHUB_RESERVED = ["about", "features", "pricing", "login", "logout", "join", "signup", "settings", "topics", "marketplace", "orgs", "sponsors", "explore", "notifications", "pulls", "issues", "search", "new", "organizations", "enterprise", "collections", "trending", "events", "apps", "readme", "security", "site", "contact", "customer-stories"];
const MAX_URL_LENGTH = 300;

function parseHttpUrl(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s || s.length > MAX_URL_LENGTH || /\s/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  return u;
}

function isPublicHostname(host) {
  const h = String(host).toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (h.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;
  return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(xn--[a-z0-9-]{2,59}|[a-z]{2,63})$/.test(h);
}

// Link website proyek: harus URL http(s) dengan domain publik, dan BUKAN link repository.
function validateWebsiteUrl(raw) {
  const u = parseHttpUrl(raw);
  if (!u) return { ok: false, reason: "invalid" };
  const host = u.hostname.toLowerCase();
  if (!isPublicHostname(host)) return { ok: false, reason: "invalid" };
  if (REPO_HOSTS.includes(host.replace(/^www\./, ""))) return { ok: false, reason: "is_repo" };
  return { ok: true, value: u.href };
}

// Link repository: harus https dan menunjuk ke repo di GitHub/GitLab/Bitbucket/Codeberg (owner/repo).
function validateRepoUrl(raw) {
  const u = parseHttpUrl(raw);
  if (!u || u.protocol !== "https:") return { ok: false, reason: "invalid" };
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (!REPO_HOSTS.includes(host)) return { ok: false, reason: "not_repo" };
  let segs = u.pathname.split("/").filter(Boolean);
  if (host === "gitlab.com") {
    const i = segs.indexOf("-");
    if (i !== -1) segs = segs.slice(0, i);
  } else {
    segs = segs.slice(0, 2);
  }
  if (segs.length < 2) return { ok: false, reason: "repo_incomplete" };
  segs = segs.map((s, i) => (i === segs.length - 1 ? s.replace(/\.git$/i, "") : s));
  const nameRe = /^[A-Za-z0-9_.-]+$/;
  if (!segs.every((s) => s && s !== "." && s !== ".." && nameRe.test(s))) return { ok: false, reason: "repo_incomplete" };
  if (host === "github.com" && GITHUB_RESERVED.includes(segs[0].toLowerCase())) return { ok: false, reason: "repo_incomplete" };
  return { ok: true, value: "https://" + host + "/" + segs.join("/") };
}
// </links-validation>

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });

  try {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body.replace(/^\uFEFF/, "") || "{}"); }
      catch (e) { return res.status(400).json({ error: "Invalid request." }); }
    }
    if (!body || typeof body !== "object") body = {};

    const teamName = String(body.team_name || "").trim();
    const projectTitle = String(body.project_title || "").trim();
    const email = String(body.email || "").trim().toLowerCase();

    // Anggota tim: minimal 1 (leader), maksimal 5
    const membersArr = (Array.isArray(body.members) ? body.members : [])
      .map((m) => String(m || "").trim())
      .filter(Boolean);

    if (!teamName || !projectTitle || !email) {
      return res.status(400).json({ error: "Please fill in all required fields." });
    }
    if (teamName.length > 150 || projectTitle.length > 200 || email.length > 200) {
      return res.status(400).json({ error: "One of the fields is too long." });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }
    if (membersArr.length < 1) {
      return res.status(400).json({ error: "Please enter at least 1 team member (Leader)." });
    }
    if (membersArr.length > 5 || membersArr.some((m) => m.length > 100)) {
      return res.status(400).json({ error: "Team members: maximum 5 names, 100 characters each." });
    }

    // Validasi link (di server, tidak bisa di-bypass dari frontend)
    const website = validateWebsiteUrl(body.website_url);
    if (!website.ok) {
      const msg = website.reason === "is_repo"
        ? "The website field needs a live website link, not a repository link."
        : "Invalid website link. It must be a full link starting with https:// (e.g. https://myproject.vercel.app).";
      return res.status(400).json({ error: msg });
    }

    const repo = validateRepoUrl(body.repo_url);
    if (!repo.ok) {
      const msg = repo.reason === "not_repo"
        ? "Invalid repository link. Only GitHub, GitLab, Bitbucket and Codeberg links are accepted."
        : repo.reason === "repo_incomplete"
          ? "The repository link must point to a repository, e.g. https://github.com/username/repository."
          : "Invalid repository link. It must be a full link starting with https://.";
      return res.status(400).json({ error: msg });
    }

    // Email wajib sudah terverifikasi OTP (memakai tabel email_otps yang sama dengan form utama).
    const otpRows = await sql`
      SELECT verified, created_at
      FROM email_otps
      WHERE email = ${email}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const otp = otpRows[0];
    const fresh = otp && Date.now() - new Date(otp.created_at).getTime() <= OTP_VALID_WINDOW_MS;
    if (!otp || otp.verified !== true || !fresh) {
      return res.status(403).json({ error: "Email not verified. Please verify your email before submitting." });
    }

    const teamMembers = membersArr.join(", ");

    await sql`
      INSERT INTO submissions_top20
        (team_name, email, project_title, team_members, website_url, repo_url, created_at)
      VALUES
        (${teamName}, ${email}, ${projectTitle}, ${teamMembers}, ${website.value}, ${repo.value}, NOW())
    `;

    // Email konfirmasi (gagal kirim tidak membatalkan submission)
    try {
      const t = escapeHtml(teamName);
      const p = escapeHtml(projectTitle);
      const m = escapeHtml(teamMembers);
      const w = escapeHtml(website.value);
      const r = escapeHtml(repo.value);
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || "AI For All Hackathon <no-reply@pindai.io>",
        to: email,
        subject: "เราได้รับผลงาน Top 20 ของคุณแล้ว / Your Top 20 Submission Has Been Received",
        html: `
          <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; color: #0A0E17; border: 1px solid #E2E8F0; border-radius: 10px; overflow: hidden;">
            <div style="background-color: #E60000; padding: 22px; text-align: center; color: #FFFFFF;">
              <h2 style="margin: 0; letter-spacing: 1px;">AI FOR ALL HACKATHON 2026</h2>
            </div>
            <div style="padding: 28px 26px; background-color: #FFFFFF; color: #1E293B; line-height: 1.6;">
              <p style="margin: 0 0 12px;">เรียน <strong>${t}</strong></p>
              <p style="margin: 0 0 18px;">เราได้รับการส่งผลงานรอบ Top 20 ของทีมคุณเรียบร้อยแล้ว</p>
              <p style="margin: 0 0 12px;">Dear <strong>${t}</strong>,</p>
              <p style="margin: 0 0 18px;">We have received your team's Top 20 submission.</p>
              <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <tr><td style="padding: 6px 0; color: #64748B; width: 150px;">Project / โปรเจกต์</td><td style="padding: 6px 0;"><strong>${p}</strong></td></tr>
                <tr><td style="padding: 6px 0; color: #64748B;">Members / สมาชิก</td><td style="padding: 6px 0;">${m}</td></tr>
                <tr><td style="padding: 6px 0; color: #64748B;">Website / เว็บไซต์</td><td style="padding: 6px 0;"><a href="${w}">${w}</a></td></tr>
                <tr><td style="padding: 6px 0; color: #64748B;">Repository</td><td style="padding: 6px 0;"><a href="${r}">${r}</a></td></tr>
              </table>
              <p style="margin: 22px 0 2px;">ขอแสดงความนับถือ / Best regards,</p>
              <p style="margin: 0;"><strong>ทีมงาน AI FOR ALL Hackathon / AI FOR ALL Hackathon Team</strong></p>
            </div>
          </div>
        `,
      });
    } catch (emailErr) {
      console.error("submit-top20: gagal mengirim email:", emailErr);
    }

    return res.status(200).json({ success: true, message: "Submission successful." });
  } catch (err) {
    console.error("submit-top20 error:", err);
    return res.status(500).json({ error: "Server error. Please try again." });
  }
}
