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

// Link repository: hanya AWS CodeCommit.
// Diterima: URL clone HTTPS  https://git-codecommit.<region>.amazonaws.com/v1/repos/<nama>
//           URL console      https://<region>.console.aws.amazon.com/codesuite/codecommit/repositories/<nama>/...
function validateRepoUrl(raw) {
  const u = parseHttpUrl(raw);
  if (!u || u.protocol !== "https:") return { ok: false, reason: "invalid" };
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split("/").filter(Boolean);
  const nameRe = /^[A-Za-z0-9_.-]{1,100}$/;
  let m = host.match(/^git-codecommit(?:-fips)?\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com(?:\.cn)?$/);
  if (m) {
    if (segs[0] !== "v1" || segs[1] !== "repos" || !segs[2]) return { ok: false, reason: "repo_incomplete" };
    const name = segs[2].replace(/\.git$/i, "");
    if (!nameRe.test(name)) return { ok: false, reason: "repo_incomplete" };
    return { ok: true, value: "https://" + host + "/v1/repos/" + name };
  }
  m = host.match(/^(?:[a-z]{2}(?:-[a-z]+)+-\d)\.console\.aws\.amazon\.com$/);
  if (m) {
    if (segs[0] !== "codesuite" || segs[1] !== "codecommit" || segs[2] !== "repositories" || !segs[3]) return { ok: false, reason: "repo_incomplete" };
    if (!nameRe.test(segs[3])) return { ok: false, reason: "repo_incomplete" };
    return { ok: true, value: u.origin + "/codesuite/codecommit/repositories/" + segs[3] + u.search };
  }
  return { ok: false, reason: "not_repo" };
}// Link video: URL http(s) dengan domain publik. Platform apa pun diterima (YouTube, Drive, Loom, dll).
function validateVideoUrl(raw) {
  const u = parseHttpUrl(raw);
  if (!u) return { ok: false, reason: "invalid" };
  if (!isPublicHostname(u.hostname.toLowerCase())) return { ok: false, reason: "invalid" };
  return { ok: true, value: u.href };
}
// </links-validation>

// <payload-validation>
function textOf(v) {
  return typeof v === "string" ? v.trim() : "";
}

// Memeriksa seluruh isian form. Mengembalikan { ok:true, data } atau { ok:false, error }.
function validatePayload(body) {
  const fail = (error) => ({ ok: false, error });

  const teamName = textOf(body.team_name);
  const projectTitle = textOf(body.project_title);
  const email = textOf(body.email).toLowerCase();

  if (!teamName || !projectTitle || !email) return fail("Please fill in all required fields.");
  if (teamName.length > 150 || projectTitle.length > 200 || email.length > 200) return fail("One of the fields is too long.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Please enter a valid email address.");

  const members = (Array.isArray(body.members) ? body.members : []).map(textOf).filter(Boolean);
  if (members.length < 1) return fail("Please enter at least 1 team member (Leader).");
  if (members.length > 5 || members.some((m) => m.length > 100)) return fail("Team members: maximum 5 names, 100 characters each.");

  // Website: WAJIB
  const website = validateWebsiteUrl(body.website_url);
  if (!website.ok) {
    return fail(website.reason === "is_repo"
      ? "The website field needs a live website link, not a repository link."
      : "Invalid website link. It must be a full link starting with https:// (e.g. https://myproject.vercel.app).");
  }

  // Repository: WAJIB dan harus link AWS CodeCommit yang benar
  let repoUrl = null;
  if (!textOf(body.repo_url)) return fail("The repository link is required.");
  {
    const repo = validateRepoUrl(body.repo_url);
    if (!repo.ok) {
      return fail(repo.reason === "not_repo"
        ? "Invalid repository link. Only AWS CodeCommit links are accepted. GitHub, GitLab and Bitbucket are not allowed."
        : repo.reason === "repo_incomplete"
          ? "The repository link must point to a CodeCommit repository, e.g. https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/repo-name."
          : "Invalid repository link. It must be a full link starting with https://.");
    }
    repoUrl = repo.value;
  }

  // Video: OPSIONAL, tapi kalau diisi harus link yang valid
  let videoUrl = null;
  if (textOf(body.video_url)) {
    const video = validateVideoUrl(body.video_url);
    if (!video.ok) return fail("Invalid video link. It must be a full link starting with https://.");
    videoUrl = video.value;
  }

  // Bedrock & AgentCore: WAJIB dijawab (true/false)
  if (typeof body.bedrock_used !== "boolean") return fail("Please answer whether Amazon Bedrock was used.");
  if (typeof body.agentcore_used !== "boolean") return fail("Please answer whether AgentCore was used.");

  return {
    ok: true,
    data: {
      teamName, projectTitle, email, members,
      teamMembers: members.join(", "),
      websiteUrl: website.value, repoUrl, videoUrl,
      bedrockUsed: body.bedrock_used, agentcoreUsed: body.agentcore_used,
    },
  };
}
// </payload-validation>

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

    // Validasi di server (tidak bisa di-bypass dari frontend)
    const v = validatePayload(body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const d = v.data;

    // Email wajib sudah terverifikasi OTP (memakai tabel email_otps yang sama dengan form utama).
    const otpRows = await sql`
      SELECT verified, created_at
      FROM email_otps
      WHERE email = ${d.email}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const otp = otpRows[0];
    const fresh = otp && Date.now() - new Date(otp.created_at).getTime() <= OTP_VALID_WINDOW_MS;
    if (!otp || otp.verified !== true || !fresh) {
      return res.status(403).json({ error: "Email not verified. Please verify your email before submitting." });
    }

    // Resubmission diperbolehkan: setiap pengiriman disimpan sebagai baris baru (riwayat lengkap),
    // dan view submissions_top20_current menampilkan yang TERAKHIR per email (email sudah diverifikasi OTP).
    await sql`
      INSERT INTO submissions_top20
        (team_name, email, project_title, team_members, website_url, repo_url, video_url, bedrock_used, agentcore_used, created_at)
      VALUES
        (${d.teamName}, ${d.email}, ${d.projectTitle}, ${d.teamMembers}, ${d.websiteUrl}, ${d.repoUrl}, ${d.videoUrl}, ${d.bedrockUsed}, ${d.agentcoreUsed}, NOW())
    `;

    // Email konfirmasi (gagal kirim tidak membatalkan submission)
    try {
      const t = escapeHtml(d.teamName);
      const p = escapeHtml(d.projectTitle);
      const m = escapeHtml(d.teamMembers);
      const w = escapeHtml(d.websiteUrl);
      const yesNo = (b) => (b ? "Yes / ใช่" : "No / ไม่ใช่");
      const row = (label, value) => `<tr><td style="padding: 6px 0; color: #64748B; width: 170px; vertical-align: top;">${label}</td><td style="padding: 6px 0;">${value}</td></tr>`;
      const link = (u) => { const e = escapeHtml(u); return `<a href="${e}">${e}</a>`; };

      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || "AI For All Hackathon <no-reply@pindai.io>",
        to: d.email,
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
                ${row("Project / โปรเจกต์", `<strong>${p}</strong>`)}
                ${row("Members / สมาชิก", m)}
                ${row("Website / เว็บไซต์", link(d.websiteUrl))}
                ${row("Repository", link(d.repoUrl))}
                ${d.videoUrl ? row("Video / วิดีโอ", link(d.videoUrl)) : ""}
                ${row("Amazon Bedrock", yesNo(d.bedrockUsed))}
                ${row("AgentCore", yesNo(d.agentcoreUsed))}
              </table>
              <p style="margin: 20px 0 4px; padding: 12px 14px; background: #F1F5F9; border-radius: 8px; font-size: 13px;">
                ส่งใหม่ได้ด้วยอีเมลเดิม ระบบจะใช้ฉบับล่าสุดเท่านั้น<br>
                You can resubmit with the same email. Only the latest submission is used.
              </p>
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
