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

    // Kirim Email Konfirmasi via Resend (bilingual: English + Thai)
    try {
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || "AI For All Hackathon <no-reply@pindai.io>",
        to: email,
        subject: "เราได้รับผลงานของคุณแล้ว — ขั้นตอนต่อไป / Your Submission Has Been Received — What Happens Next",
        html: `
          <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; color: #0A0E17; border: 1px solid #E2E8F0; border-radius: 10px; overflow: hidden;">
            <div style="background-color: #E60000; padding: 22px; text-align: center; color: #FFFFFF;">
              <div style="font-size: 12px; letter-spacing: 3px; opacity: 0.85;">HACKATHON</div>
              <h2 style="margin: 6px 0 0; letter-spacing: 1px;">AI FOR ALL HACKATHON 2026</h2>
            </div>

            <div style="padding: 28px 26px; background-color: #FFFFFF; color: #1E293B; line-height: 1.6;">

              <!-- ===== THAI ===== -->
              <p style="margin: 0 0 14px;">เรียน <strong>${teamName}</strong></p>
              <p style="margin: 0 0 18px;">ขอบคุณที่ส่งผลงานแนวคิด <strong>"${projectTitle}"</strong> (${projectTheme}) เข้าร่วมโครงการ AI FOR ALL Hackathon 2026 เราได้รับผลงานของทีมคุณเรียบร้อยแล้ว</p>

              <p style="margin: 0 0 10px; font-weight: 700; color: #0A0E17;">ขั้นตอนถัดไปมีดังนี้:</p>

              <p style="margin: 0 0 4px;"><strong>1. ประกาศรายชื่อ Top 20 — วันที่ 10 พฤศจิกายน 2569</strong></p>
              <p style="margin: 0 0 14px; color: #475569;">รายชื่อ 20 ทีมที่ผ่านการคัดเลือกจะประกาศทางเว็บไซต์ True</p>

              <p style="margin: 0 0 4px;"><strong>2. ค่ายอบรมเชิงปฏิบัติการ (Bootcamp) ที่กรุงเทพฯ — วันที่ 21–22 พฤศจิกายน 2569</strong></p>
              <p style="margin: 0 0 14px; color: #475569;">ทีม Top 20 ทุกทีมจะต้องเดินทางมากรุงเทพฯ เพื่อเข้าร่วม Bootcamp แบบ onsite เป็นเวลา 2 วันเต็ม โดยโครงการจะรับผิดชอบค่าเดินทางและที่พักให้กับสมาชิกทีมสูงสุด 5 คน (ขึ้นอยู่กับการยืนยันขั้นสุดท้าย)</p>

              <p style="margin: 0 0 4px;"><strong>3. การพัฒนาต้นแบบ</strong></p>
              <p style="margin: 0 0 14px; color: #475569;">ระหว่าง Bootcamp แต่ละทีมจะพัฒนาแนวคิดต่อยอดเป็นต้นแบบ (Prototype) โดยใช้ Amazon Kiro พร้อมคำแนะนำจากผู้เชี่ยวชาญ</p>

              <p style="margin: 0 0 4px;"><strong>4. Demo Day — คัดเลือก Top 5</strong></p>
              <p style="margin: 0 0 14px; color: #475569;">เมื่อสิ้นสุด Bootcamp แต่ละทีมจะนำเสนอต้นแบบต่อคณะกรรมการ เพื่อคัดเลือกทีมสุดท้าย 5 ทีม</p>

              <p style="margin: 0 0 4px;"><strong>5. รอบชิงชนะเลิศ — วันที่ 12 ธันวาคม 2569</strong></p>
              <p style="margin: 0 0 18px; color: #475569;">5 ทีมสุดท้ายจะนำเสนอผลงานรอบชิงชนะเลิศและร่วมพิธีมอบรางวัล ที่กรุงเทพฯ</p>

              <p style="margin: 0 0 6px;">เราจะแจ้งรายละเอียดเพิ่มเติมของแต่ละขั้นตอนให้ทราบล่วงหน้า ขอบคุณที่เป็นส่วนหนึ่งของ AI FOR ALL และขอให้โชคดี!</p>
              <p style="margin: 0 0 2px;">ขอแสดงความนับถือ</p>
              <p style="margin: 0;"><strong>ทีมงาน AI FOR ALL Hackathon</strong><br/>Thaksa AI project under TURAC</p>

              <hr style="border: none; border-top: 1px solid #E2E8F0; margin: 26px 0;" />

              <!-- ===== ENGLISH ===== -->
              <p style="margin: 0 0 14px;">Dear <strong>${teamName}</strong>,</p>
              <p style="margin: 0 0 18px;">Thank you for submitting your ideation <strong>"${projectTitle}"</strong> (${projectTheme}) to the AI FOR ALL Hackathon 2026. We have successfully received your team's submission.</p>

              <p style="margin: 0 0 10px; font-weight: 700; color: #0A0E17;">Here's what happens next:</p>

              <p style="margin: 0 0 4px;"><strong>1. Top 20 Announcement — 10 November 2026</strong></p>
              <p style="margin: 0 0 14px; color: #475569;">The list of the Top 20 teams selected to advance will be announced on the True website.</p>

              <p style="margin: 0 0 4px;"><strong>2. Bootcamp in Bangkok — 21–22 November 2026</strong></p>
              <p style="margin: 0 0 14px; color: #475569;">If selected as one of the Top 20 teams, your team will need to be physically in Bangkok for a 2-day, on-site Bootcamp. Reasonable transportation and accommodation are planned to be provided for up to 5 members per team, subject to final confirmation.</p>

              <p style="margin: 0 0 4px;"><strong>3. Prototype Development</strong></p>
              <p style="margin: 0 0 14px; color: #475569;">During the Bootcamp, teams will further develop their ideation into a working prototype using Amazon Kiro, with guidance from experts.</p>

              <p style="margin: 0 0 4px;"><strong>4. Demo Day — Top 5 Selection</strong></p>
              <p style="margin: 0 0 14px; color: #475569;">At the end of the Bootcamp, each team will present their prototype to the judges, who will select the Top 5 finalist teams.</p>

              <p style="margin: 0 0 4px;"><strong>5. Grand Final — 12 December 2026</strong></p>
              <p style="margin: 0 0 18px; color: #475569;">The Top 5 teams will present their final work at the Grand Final and awards ceremony, scheduled for 12 December 2026 in Bangkok.</p>

              <p style="margin: 0 0 6px;">We'll be in touch with further details as each stage approaches. Thank you for being part of AI FOR ALL — good luck!</p>
              <p style="margin: 0 0 2px;">Best regards,</p>
              <p style="margin: 0;"><strong>AI FOR ALL Hackathon Team</strong><br/>Thaksa AI project under TURAC</p>
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
