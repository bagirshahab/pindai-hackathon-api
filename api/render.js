import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

// Fungsi untuk mengonversi teks menjadi slug URL
function slugify(text) {
  if (!text) return "";
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")           // Spasi diganti dash (-)
    .replace(/[^\w\-]+/g, "")       // Hapus simbol khusus
    .replace(/\-\-+/g, "-");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).send("Method Not Allowed");
  }

  let { filename } = req.query;

  if (!filename) {
    return res.status(400).send("Project title or slug is required.");
  }

  // Bersihkan ekstensi .html jika dimasukkan di URL
  const rawTitle = filename.replace(/\.html$/i, "").toLowerCase();
  
  // Ubah tanda hubung (-) dari URL kembali menjadi spasi (contoh: "ketahanan-pangan" -> "ketahanan pangan")
  const titleWithSpaces = rawTitle.replace(/-/g, " ");

  try {
    // 1. Cari berdasarkan judul dengan spasi atau judul mentah
    let result = await sql`
      SELECT html_content, judul_proyek 
      FROM hackathon_submissions 
      WHERE LOWER(judul_proyek) = LOWER(${titleWithSpaces})
         OR LOWER(judul_proyek) = LOWER(${rawTitle})
      LIMIT 1;
    `;

    let submission = result[0];

    // 2. Jika belum cocok, lakukan pencarian fleksibel berbasis slugify
    if (!submission) {
      const allSubmissions = await sql`SELECT html_content, judul_proyek FROM hackathon_submissions`;
      submission = allSubmissions.find(sub => slugify(sub.judul_proyek) === rawTitle);
    }

    // Jika data tidak ditemukan
    if (!submission || !submission.html_content) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head><title>404 - Not Found</title></head>
        <body style="font-family:sans-serif; text-align:center; padding-top:50px; background:#0A0E17; color:#FFF;">
          <h1>404 - Proyek Tidak Ditemukan</h1>
          <p>Proyek dengan judul "${rawTitle}" tidak ditemukan dalam sistem.</p>
        </body>
        </html>
      `);
    }

    // Render halaman HTML
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate");

    return res.status(200).send(submission.html_content);
  } catch (error) {
    console.error("Error rendering project submission:", error);
    return res.status(500).send("Server error rendering file.");
  }
}
