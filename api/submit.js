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

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });

  try {
    // Mengizinkan field file kosong agar tidak melempar FormidableError
    const form = formidable({ 
      maxFileSize: MAX_FILE_SIZE,
      allowEmptyFiles: true,
      minFileSize: 0
    });

    const [fields, files] = await form.parse(req);

    const teamName = fields.team_name?.[0]?.trim();
    const email = fields.email?.[0]?.trim();
    const teamMembers = fields.team_members_list?.[0]?.trim();
    const projectTitle = fields.project_title?.[0]?.trim();
    const description = fields.project_description?.[0]?.trim();
    const htmlUrl = fields.html_url?.[0]?.trim() || "";
    const file = files.file_html?.[0];

    // Validasi field utama
    if (!teamName || !email || !projectTitle || !description) {
      return res.status(400).json({ error: "Please fill in all required fields." });
    }

    let fileName = "";
    let htmlContent = "";

    // Cek jika file benar-benar diunggah dan tidak kosong (size > 0)
    if (file && file.size > 0 && file.filepath) {
      fileName = file.originalFilename || "";
      htmlContent = fs.readFileSync(file.filepath, "utf-8");
    }

    // Simpan Ke NeonDB
    await sql`
      INSERT INTO hackathon_submissions
        (nama, email, instansi, judul_proyek, description, html_url, file_name, html_content)
      VALUES
        (${teamName}, ${email}, ${teamMembers}, ${projectTitle}, ${description}, ${htmlUrl}, ${fileName}, ${htmlContent})
    `;

    // Kirim Email Konfirmasi via Resend
    try {
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev",
        to: email,
        subject: "Submission Received — Thailand AI Hackathon 2026",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; color: #111; border: 1px solid #1E293B; border-radius: 8px; overflow: hidden;">
            <div style="background-color: #E60000; padding: 20px; text-align: center; color: #FFF;">
              <h2 style="margin: 0;">THAILAND AI HACKATHON</h2>
            </div>
            <div style="padding: 24px; background-color: #0A0E17; color: #F8FAFC;">
              <p>Hello <strong>${teamName}</strong>,</p>
              <p>Thank you for submitting your project, <strong>"${projectTitle}"</strong>, for the Thailand AI Hackathon 2026.</p>
              <p>Our judging panel will review your submission shortly. If further details are needed, we will reach out to this email address.</p>
              <p style="margin-top: 24px;">Best regards,<br/><strong>Thailand AI Hackathon Committee</strong></p>
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
