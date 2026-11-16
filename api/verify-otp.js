import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

const sql = neon(process.env.DATABASE_URL);

const MAX_ATTEMPTS = 5; // batas percobaan salah per kode

function setCorsHeaders(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Perbandingan kode tanpa membocorkan informasi lewat waktu respons.
function codesMatch(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });

  // Parsing body: input yang salah format dijawab 400, bukan 500.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body.replace(/^\uFEFF/, "") || "{}"); }
    catch (e) { return res.status(400).json({ error: "Invalid request." }); }
  }
  if (!body || typeof body !== "object") body = {};

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const otpCode = typeof body.otp_code === "string" || typeof body.otp_code === "number"
    ? String(body.otp_code).trim()
    : "";

  if (!email || !otpCode) {
    return res.status(400).json({ error: "Email and verification code are required." });
  }

  try {
    // Ambil OTP terbaru untuk email ini
    const rows = await sql`
      SELECT id, expires_at, verified
      FROM email_otps
      WHERE email = ${email}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const record = rows[0];

    if (!record) {
      return res.status(400).json({ error: "No verification code found. Please request a new code." });
    }

    if (record.verified) {
      return res.status(200).json({ success: true, message: "Email already verified." });
    }

    if (new Date(record.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "The code has expired. Please request a new one." });
    }

    // Pesan satu jatah percobaan secara ATOMIK sebelum kode dibandingkan.
    // Cek batas dan penambahan counter terjadi dalam satu query, jadi request
    // paralel tidak bisa melewati MAX_ATTEMPTS. Kalau tidak ada baris yang
    // dikembalikan, batas sudah habis.
    const reserved = await sql`
      UPDATE email_otps
      SET attempts = attempts + 1
      WHERE id = ${record.id} AND verified = false AND attempts < ${MAX_ATTEMPTS}
      RETURNING otp_code
    `;

    if (reserved.length === 0) {
      return res.status(429).json({ error: "Too many attempts. Please request a new code." });
    }

    if (!codesMatch(reserved[0].otp_code, otpCode)) {
      return res.status(400).json({ error: "Incorrect verification code." });
    }

    // Kode benar → tandai terverifikasi
    await sql`
      UPDATE email_otps SET verified = true WHERE id = ${record.id}
    `;

    return res.status(200).json({ success: true, message: "Email verified successfully." });
  } catch (err) {
    console.error("verify-otp error:", err);
    return res.status(500).json({ error: "Server error. Please try again." });
  }
}
