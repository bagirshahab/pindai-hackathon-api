import { neon } from "@neondatabase/serverless";
import { Resend } from "resend";

const sql = neon(process.env.DATABASE_URL);
const resend = new Resend(process.env.RESEND_API_KEY);

const OTP_TTL_MINUTES = 10; // OTP berlaku 10 menit
const RESEND_COOLDOWN_SECONDS = 60; // jeda minimal antar pengiriman OTP ke email yang sama

function setCorsHeaders(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateOtp() {
  // 6 digit, selalu 6 karakter (tidak diawali 0 yang hilang)
  return String(Math.floor(100000 + Math.random() * 900000));
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    if (!body) body = {};

    const email = (body.email || "").trim().toLowerCase();

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    // Rate limit: cek apakah baru saja mengirim OTP ke email ini
    const recent = await sql`
      SELECT created_at
      FROM email_otps
      WHERE email = ${email}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (recent[0]) {
      const lastSent = new Date(recent[0].created_at).getTime();
      const diffSeconds = (Date.now() - lastSent) / 1000;
      if (diffSeconds < RESEND_COOLDOWN_SECONDS) {
        const wait = Math.ceil(RESEND_COOLDOWN_SECONDS - diffSeconds);
        return res.status(429).json({
          error: `Please wait ${wait} seconds before requesting a new code.`,
        });
      }
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    // Simpan OTP baru. Kode lama untuk email yang sama dianggap tidak berlaku
    // karena verifikasi selalu mengambil record terbaru.
    await sql`
      INSERT INTO email_otps (email, otp_code, expires_at, verified, created_at)
      VALUES (${email}, ${otp}, ${expiresAt.toISOString()}, false, NOW())
    `;

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "AI For All Hackathon <no-reply@pindai.io>",
      to: email,
      subject: "Your Verification Code — AI For All Hackathon 2026",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; color: #111; border: 1px solid #1E293B; border-radius: 8px; overflow: hidden;">
          <div style="background-color: #E60000; padding: 20px; text-align: center; color: #FFF;">
            <h2 style="margin: 0; letter-spacing: 1px;">AI FOR ALL HACKATHON</h2>
          </div>
          <div style="padding: 24px; background-color: #0A0E17; color: #F8FAFC; text-align: center;">
            <p style="margin: 0 0 12px;">Your email verification code is:</p>
            <div style="font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #FFCC00; margin: 16px 0;">${otp}</div>
            <p style="font-size: 13px; color: #94A3B8; margin: 8px 0 0;">This code is valid for ${OTP_TTL_MINUTES} minutes. Do not share it with anyone.</p>
            <p style="margin-top: 24px; border-top: 1px solid #1E293B; padding-top: 16px; font-size: 12px; color: #64748B;">
              รหัสยืนยันอีเมลของคุณคือ ${otp} (ใช้ได้ ${OTP_TTL_MINUTES} นาที)
            </p>
          </div>
        </div>
      `,
    });

    return res.status(200).json({ success: true, message: "Verification code sent." });
  } catch (err) {
    console.error("send-otp error:", err);
    return res.status(500).json({ error: "Server error. Please try again." });
  }
}
