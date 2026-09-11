import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

// Fungsi untuk mengonversi judul proyek menjadi format slug URL
function slugify(text) {
  if (!text) return "";
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")           // Ganti spasi dengan -
    .replace(/[^\w\-]+/g, "")       // Hapus karakter khusus
    .replace(/\-\-+/g, "-");        // Ganti multiple - dengan single -
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).send("Method Not Allowed");
  }

  let { filename } = req.query;

  if (!filename) {
    return res.status(400).send("Project title or slug is required.");
  }

  // Bersihkan ekstensi .html jika ada
  const cleanTitle = filename.replace(/\.html$/i, "").toLowerCase();

  try {
    // 1. Cari yang cocok persis dengan judul_proyek di database
    let result = await sql`
      SELECT html_content, judul_proyek 
      FROM hackathon_submissions 
      WHERE LOWER(judul_proyek) = LOWER(${cleanTitle})
      LIMIT 1;
    `;

    let submission = result[0];

    // 2. Jika tidak cocok persis, cocokkan berdasarkan slug dari judul_proyek
    if (!submission) {
      const allSubmissions = await sql`SELECT html_content, judul_proyek FROM hackathon_submissions`;
      submission = allSubmissions.find(sub => slugify(sub.judul_proyek) === cleanTitle);
    }

    // Jika data tidak ditemukan atau file HTML kosong
    if (!submission || !submission.html_content) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head><title>404 - Not Found</title></head>
        <body style="font-family:sans-serif; text-align:center; padding-top:50px; background:#0A0E17; color:#FFF;">
          <h1>404 - Proyek Tidak Ditemukan</h1>
          <p>Proyek dengan judul "${cleanTitle}" tidak ditemukan dalam sistem.</p>
        </body>
        </html>
      `);
    }

    // Tampilkan isi dokumen HTML
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate");

    return res.status(200).send(submission.html_content);
  } catch (error) {
    console.error("Error rendering project submission:", error);
    return res.status(500).send("Server error rendering file.");
  }
}
