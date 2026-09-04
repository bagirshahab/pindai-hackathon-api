import { neon } from "@neondatabase/serverless";
import { Resend } from "resend";
import formidable from "formidable";
import fs from "fs";

// Vercel: matikan bodyParser bawaan karena kita pakai formidable (multipart/form-data)
export const config = {
  api: {
    bodyParser: false,
  },
};

const sql = neon(process.env.DATABASE_URL);
const resend = new Resend(process.env.RESEND_API_KEY);

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setCorsHeaders(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const form = formidable({ maxFileSize: MAX_FILE_SIZE });
    const [fields, files] = await form.parse(req);

    const nama = fields.nama?.[0]?.trim();
    const email = fields.email?.[0]?.trim();
    const noWa = fields.no_wa?.[0]?.trim();
    const instansi = fields.instansi?.[0]?.trim();
    const judulProyek = fields.judul_proyek?.[0]?.trim();
    const file = files.file_html?.[0];

    // ---- Validasi ----
    if (!nama || !email || !noWa || !instansi || !judulProyek || !file) {
      return res.status(400).json({ error: "Semua field wajib diisi." });
    }

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Format email tidak valid." });
    }

    const fileName = file.originalFilename || "";
    const isHtml = fileName.toLowerCase().endsWith(".html") || fileName.toLowerCase().endsWith(".htm");
    if (!isHtml) {
      return res.status(400).json({ error: "File harus berformat .html atau .htm." });
    }

    if (file.size > MAX_FILE_SIZE) {
      return res.status(400).json({ error: "Ukuran file maksimal 5MB." });
    }

    const htmlContent = fs.readFileSync(file.filepath, "utf-8");

    // ---- Simpan ke NeonDB ----
    await sql`
      INSERT INTO hackathon_submissions
        (nama, email, no_wa, instansi, judul_proyek, file_name, html_content)
      VALUES
        (${nama}, ${email}, ${noWa}, ${instansi}, ${judulProyek}, ${fileName}, ${htmlContent})
    `;

    // ---- Kirim email terima kasih ----
    try {
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL,
        to: email,
        subject: "Terima kasih telah submit proyek — PindAI x Thailand Hackathon",
        html: buildThankYouEmail(nama, judulProyek),
      });
    } catch (emailErr) {
      // Data sudah tersimpan; jangan gagalkan submission hanya karena email gagal terkirim
      console.error("Gagal mengirim email:", emailErr);
    }

    return res.status(200).json({ success: true, message: "Submission berhasil." });
  } catch (err) {
    console.error(err);
    if (err?.code === 1009 || /maxFileSize/i.test(err?.message || "")) {
      return res.status(400).json({ error: "Ukuran file maksimal 5MB." });
    }
    return res.status(500).json({ error: "Terjadi kesalahan pada server. Silakan coba lagi." });
  }
}

function buildThankYouEmail(nama, judulProyek) {
  return `
  <div style="font-family: 'Inter', Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1F2937;">
    <div style="background-color:#122746; padding: 24px; border-radius: 8px 8px 0 0; text-align:center;">
      <span style="color:#F3F4F6; font-weight:800; font-size:18px;">Pintar dengan AI</span><br/>
      <span style="color:#EF7D00; font-size:12px; font-weight:600;">by PindAI</span>
    </div>
    <div style="padding: 28px 24px; border: 1px solid #E5E7EB; border-top: none; border-radius: 0 0 8px 8px;">
      <p>Halo <strong>${escapeHtml(nama)}</strong>,</p>
      <p>
        Terima kasih telah mengirimkan proyekmu, <strong>"${escapeHtml(judulProyek)}"</strong>,
        untuk PindAI x Thailand Hackathon. Kami senang melihat apa yang sudah kamu bangun!
      </p>
      <p>
        Tim kami akan meninjau proyekmu dalam waktu dekat. Jika ada informasi tambahan yang
        diperlukan, kami akan menghubungimu melalui email ini atau nomor WhatsApp yang kamu
        daftarkan.
      </p>
      <p>
        Sampai saat itu, teruslah bereksperimen dan berkarya dengan AI. Kami tidak sabar untuk
        melihat lebih banyak proyek darimu.
      </p>
      <p style="margin-top: 24px;">Salam hangat,<br/><strong>Tim PindAI</strong></p>
    </div>
    <p style="text-align:center; font-size: 11px; color: #9CA3AF; margin-top: 16px;">
      © 2026 PindAI · Pintar dengan AI
    </p>
  </div>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
