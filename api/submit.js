import { neon } from "@neondatabase/serverless";
import { Resend } from "resend";
import formidable from "formidable";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false,
  },
};

const sql = neon(process.env.DATABASE_URL);
const resend = new Resend(process.env.RESEND_API_KEY);

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

function setCorsHeaders(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function hasExtension(filename, extensions) {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

// Cek apakah isi file benar-benar terlihat seperti dokumen HTML.
// Markdown boleh mengandung sedikit tag, jadi kita cari tanda struktur HTML yang kuat.
function looksLikeHtml(content) {
  if (!content) return false;
  const c = content.trim().toLowerCase();
  return (
    c.includes("<!doctype html") ||
    c.includes("<html") ||
    c.includes("<body") ||
    c.includes("<head") ||
    // Beberapa tag HTML umum sebagai indikasi kuat
    /<(div|p|span|table|script|style|section|header|footer|h1|h2|ul|ol|img|a)\b/.test(c)
  );
}

// Cek apakah isi file adalah dokumen HTML utuh (dipakai untuk menolak HTML
// yang di-rename jadi .md). Markdown normal tidak diawali struktur dokumen HTML.
function isFullHtmlDocument(content) {
  if (!content) return false;
  const c = content.trim().toLowerCase();
  return c.startsWith("<!doctype html") || c.startsWith("<html");
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });

  try {
    const form = formidable({ 
      maxFileSize: MAX_FILE_SIZE,
      allowEmptyFiles: true,
      minFileSize: 0
    });

    const [fields, files] = await form.parse(req);

    const teamName = fields.team_name?.[0]?.trim();
    const email = fields.email?.[0]?.trim();
    
    // Menggabungkan anggota tim (member_1 sampai member_5) secara otomatis
    let membersArr = [];
    for (let i = 1; i <= 5; i++) {
      let m = fields[`member_${i}`]?.[0]?.trim();
      if (m) membersArr.push(m);
    }
    const teamMembers = membersArr.join(", ");

    const projectTitle = fields.project_title?.[0]?.trim();
    const projectTheme = fields.project_theme?.[0]?.trim();
    const description = fields.project_description?.[0]?.trim();
    
    const fileHtml = files.file_html?.[0];
    const fileMd = files.file_md?.[0];

    // Validasi field utama
    if (!teamName || !email || !projectTitle || !projectTheme || !description) {
      return res.status(400).json({ error: "Please fill in all required fields." });
    }

    // Team members: minimal 1 anggota (leader) wajib ada
    if (membersArr.length < 1) {
      return res.status(400).json({ error: "Please enter at least 1 team member (Leader)." });
    }

    // Batasi panjang deskripsi (maks 100 kata untuk EN, atau ~600 karakter untuk Thai).
    // Sejalan dengan validasi frontend agar tidak bisa di-bypass lewat API.
    const descWordCount = description.split(/\s+/).filter(Boolean).length;
    const descCharCount = description.replace(/\s/g, "").length;
    if (descWordCount > 100 || descCharCount > 600) {
      return res.status(400).json({ error: "Description exceeds the 100-word limit." });
    }

    // Validasi: email harus sudah terverifikasi via OTP sebelum bisa submit.
    // Ini mencegah bypass frontend (submit langsung ke API tanpa verifikasi).
    const normalizedEmail = email.toLowerCase();
    const verifiedRows = await sql`
      SELECT verified
      FROM email_otps
      WHERE email = ${normalizedEmail}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (!verifiedRows[0] || verifiedRows[0].verified !== true) {
      return res.status(403).json({ error: "Email not verified. Please verify your email before submitting." });
    }

    let htmlFileName = "";
    let htmlContent = "";
    let mdPath = "";
    let mdContent = ""; // Variabel untuk menampung isi teks file Markdown

    // File HTML wajib diunggah
    if (!fileHtml || fileHtml.size <= 0 || !fileHtml.filepath) {
      return res.status(400).json({ error: "Please upload an HTML file." });
    }
    htmlFileName = fileHtml.originalFilename || "";
    // Validasi ekstensi: field HTML hanya menerima .html / .htm
    if (!hasExtension(htmlFileName, [".html", ".htm"])) {
      return res.status(400).json({ error: "Invalid HTML file. Only .html or .htm files are accepted." });
    }
    htmlContent = fs.readFileSync(fileHtml.filepath, "utf-8");
    // Validasi isi: file HTML harus benar-benar berisi HTML, bukan teks/markdown yang di-rename.
    if (!looksLikeHtml(htmlContent)) {
      return res.status(400).json({ error: "The HTML file content does not look like valid HTML. Please upload a real HTML file." });
    }

    // File Markdown (.md) wajib diunggah
    if (!fileMd || fileMd.size <= 0 || !fileMd.filepath) {
      return res.status(400).json({ error: "Please upload a Markdown (.md) file." });
    }
    mdPath = fileMd.originalFilename || "";
    // Validasi ekstensi: field Markdown hanya menerima .md
    if (!hasExtension(mdPath, [".md"])) {
      return res.status(400).json({ error: "Invalid Markdown file. Only .md files are accepted." });
    }
    mdContent = fs.readFileSync(fileMd.filepath, "utf-8"); // Membaca isi teks file .md
    // Validasi isi: file Markdown tidak boleh berupa dokumen HTML utuh yang di-rename jadi .md.
    if (isFullHtmlDocument(mdContent)) {
      return res.status(400).json({ error: "The Markdown file appears to be an HTML document. Please upload a real Markdown (.md) file." });
    }

    // Simpan ke NeonDB (menyertakan kolom md_content)
    await sql`
      INSERT INTO submissions
        (full_name, email, team_members, project_title, project_theme, description, html_content, md_path, md_content, created_at)
      VALUES
        (${teamName}, ${email}, ${teamMembers}, ${projectTitle}, ${projectTheme}, ${description}, ${htmlContent}, ${mdPath}, ${mdContent}, NOW())
    `;

    // Kirim Email Konfirmasi via Resend
    try {
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || "AI For All Hackathon <no-reply@pindai.io>",
        to: email,
        subject: "Submission Received — AI For All Hackathon 2026",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; color: #111; border: 1px solid #1E293B; border-radius: 8px; overflow: hidden;">
            <div style="background-color: #E60000; padding: 20px; text-align: center; color: #FFF;">
              <h2 style="margin: 0; letter-spacing: 1px;">AI FOR ALL HACKATHON</h2>
            </div>
            <div style="padding: 24px; background-color: #0A0E17; color: #F8FAFC;">
              <p>Hello <strong>${teamName}</strong>,</p>
              <p>Thank you for submitting your project, <strong>"${projectTitle}"</strong> (${projectTheme}), for the AI For All Hackathon 2026.</p>
              <p>Our judging panel will review your submission shortly. If further details are needed, we will reach out to this email address.</p>
              <p style="margin-top: 24px; border-top: 1px solid #1E293B; padding-top: 16px;">Best regards,<br/><strong>AI For All Hackathon Committee</strong></p>
            </div>
          </div>
        `
      });
    } catch (emailErr) {
      console.error("Gagal mengirim email:", emailErr);
    }

    return res.status(200).json({ success: true, message: "Submission successful." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error. Please try again." });
  }
}
