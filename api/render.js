import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).send("Method Not Allowed");
  }

  let { filename } = req.query;

  if (!filename) {
    return res.status(400).send("Project title or slug is required.");
  }

  // 1. Ambil teks murni dari URL (contoh: "ketahanan-pangan.html" -> "ketahanan pangan")
  const rawSlug = filename.replace(/\.html$/i, "").toLowerCase();
  const searchPattern = `%${rawSlug.replace(/-/g, "%")}%`; // Menjadi "%ketahanan%pangan%"

  try {
    // 2. Query Neon DB dengan pola ILIKE fleksibel
    const result = await sql`
      SELECT html_content, judul_proyek 
      FROM hackathon_submissions 
      WHERE LOWER(judul_proyek) ILIKE ${searchPattern}
         OR LOWER(file_name) ILIKE ${searchPattern}
         OR LOWER(nama) ILIKE ${searchPattern}
      ORDER BY id DESC
      LIMIT 1;
    `;

    const submission = result[0];

    // Jika record tidak ditemukan sama sekali di database
    if (!submission) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head><title>404 - Not Found</title></head>
        <body style="font-family:sans-serif; text-align:center; padding-top:50px; background:#0A0E17; color:#FFF;">
          <h1>404 - Proyek Tidak Ditemukan</h1>
          <p>Proyek "${rawSlug}" tidak ada di database.</p>
        </body>
        </html>
      `);
    }

    // Jika data ditemukan TAPI kolom html_content ternyata kosong / NULL
    if (!submission.html_content || submission.html_content.trim() === "") {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head><title>HTML Kosong</title></head>
        <body style="font-family:sans-serif; text-align:center; padding-top:50px; background:#0A0E17; color:#FFF;">
          <h1 style="color:#FFCC00;">Proyek Ditemukan, Tapi File HTML Kosong!</h1>
          <p>Judul Proyek: <strong>${submission.judul_proyek}</strong></p>
          <p>Peserta tidak mengunggah file .html saat submit, atau isi kolom <code>html_content</code> di database masih kosong.</p>
        </body>
        </html>
      `);
    }

    // 3. Render isi file HTML jika ada
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate");

    return res.status(200).send(submission.html_content);
  } catch (error) {
    console.error("Error rendering project submission:", error);
    return res.status(500).send("Server error rendering file.");
  }
}
