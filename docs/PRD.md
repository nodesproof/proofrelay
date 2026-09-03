# ProofRelay — Product Requirements Document

**Versi:** 1.0 MVP

**Status:** Draft siap implementasi

**Tanggal:** 31 Agustus 2026

**Target event:** 0G Bridge by AKINDO

## 1. Ringkasan eksekutif

ProofRelay adalah dApp **onchain evidence market** untuk menghasilkan dan memverifikasi bukti atas klaim yang dibuat oleh AI. Pengguna membuat task, menyetor bounty, dan mengunggah pertanyaan atau dokumen publik. Beberapa verifier AI memproses task secara independen. Sistem menghasilkan claim–evidence graph, menyimpan artefak dan metadata ke 0G Storage, menggunakan 0G Compute untuk inference/verifikasi, lalu menyelesaikan pembayaran, attestation, atau dispute melalui smart contract di 0G Chain.

Produk ini tidak menjanjikan kebenaran absolut. ProofRelay memberikan **provenance, reproducibility, confidence, dan conflict visibility** sehingga pengguna dapat mengetahui dasar sebuah jawaban dan apakah verifier berbeda pendapat.

## 2. Latar belakang dan masalah

Model AI dapat membuat jawaban yang terdengar meyakinkan tetapi tidak didukung sumber, memakai sumber yang telah berubah, atau mencampurkan beberapa klaim yang sebenarnya memiliki tingkat kepastian berbeda. Dalam proses riset, due diligence, evaluasi dokumentasi, dan monitoring open-source project, masalah utama bukan hanya menghasilkan jawaban, melainkan membuktikan bagaimana jawaban tersebut diperoleh.

Sistem terpusat umumnya menyimpan prompt, sumber, model, dan hasil penilaian di database privat. Pengguna kesulitan memverifikasi versi sumber, membandingkan hasil beberapa verifier, atau menyelesaikan sengketa pembayaran secara netral. ProofRelay menyelesaikan masalah tersebut dengan mengubah verifikasi menjadi workflow yang memiliki **bounty, escrow, evidence artifact, verifier output, dispute window, dan onchain settlement**.

## 3. Tujuan produk

| Tujuan | Definisi keberhasilan MVP |
|---|---|
| Membuat output AI dapat diaudit | Setiap hasil memiliki daftar klaim, sumber, quoted span, content hash, model ID, timestamp, dan verdict. |
| Membuktikan penggunaan 0G | Demo menggunakan 0G Storage untuk artefak dan 0G Compute untuk minimal satu pipeline inference/verifikasi. |
| Membuat verifikasi multi-pihak | Minimal dua verifier independen dapat memproses task yang sama dan menghasilkan verdict berbeda atau sama. |
| Menyelesaikan pembayaran secara transparan | Smart contract dapat membayar verifier pada kondisi agreement dan menahan pembayaran saat dispute. |
| Menyediakan demo yang mudah dipahami | Pengguna dapat menyelesaikan satu task publik dalam kurang dari lima menit pada testnet. |

## 4. Non-goals MVP

MVP tidak mencakup pelatihan model foundation sendiri, jaminan legal atau medis, verifikasi kebenaran dunia nyata secara absolut, anonymous human labor marketplace berskala besar, private enterprise data tanpa konfigurasi keamanan tambahan, model unlearning, atau token yang dapat diperdagangkan. MVP juga tidak akan menyimpan data pribadi sensitif secara plaintext pada storage publik.

## 5. Target pengguna

| Persona | Kebutuhan | Pekerjaan yang diselesaikan ProofRelay |
|---|---|---|
| Researcher atau builder | Memvalidasi klaim teknis dan sumber | Membuat task evidence dan membandingkan verifier. |
| DAO atau protocol team | Memeriksa perubahan dokumentasi, proposal, dan risk claim | Mendapat report dengan provenance dan status dispute. |
| AI agent developer | Membuktikan reliabilitas agent | Mengirim output agent ke verifier independen. |
| Verifier AI operator | Memonetisasi pipeline retrieval/evaluation | Mendaftarkan verifier dan menerima bounty. |
| Judge atau evaluator | Menilai apakah produk benar-benar memakai 0G | Melihat artifact hash, transaction, dan workflow end-to-end. |

## 6. Product principles

Pertama, **evidence before confidence**: confidence tidak boleh ditampilkan tanpa evidence pointer. Kedua, **disagreement is a feature**: konflik antar-verifier harus terlihat, bukan disembunyikan. Ketiga, **onchain minimum, offchain scalable**: data besar berada di 0G Storage/Compute, sedangkan state settlement dan integrity pointer berada di chain. Keempat, **reproducibility over magic**: setiap report harus menyebut model, prompt template, data snapshot, dan versi pipeline. Kelima, **safe defaults**: demo menggunakan data publik dan tidak memberikan keputusan investasi, medis, legal, atau kredit.

## 7. User journey utama

### 7.1 Task creator

Pengguna menghubungkan wallet, memilih jenis task, menuliskan pertanyaan, mengunggah dokumen atau URL publik, menentukan jumlah verifier, bounty, deadline, dan aturan verdict. Setelah menyetujui transaksi escrow, task berstatus `OPEN`. Sistem membuat task manifest dan menyimpannya ke 0G Storage.

Verifier yang memenuhi kriteria mengambil task. Setiap verifier mengunduh manifest, mengambil sumber yang sama, membangun claim–evidence graph, lalu mengirim hasil yang ditandatangani. Backend menyimpan report lengkap ke 0G Storage dan mengirim pointer ke smart contract. Setelah batas waktu terpenuhi, kontrak menghitung agreement. Jika tidak ada challenge, payout dijalankan. Jika ada challenge, task masuk `DISPUTED`.

### 7.2 Verifier

Verifier mendaftarkan endpoint atau worker ID dan konfigurasi modelnya. Untuk MVP, verifier dapat berupa worker yang dikendalikan oleh tim dengan dua konfigurasi berbeda. Verifier mengambil task, mengembalikan verdict untuk setiap claim, evidence pointer, confidence, dan hash input. Verifier tidak boleh melihat output verifier lain sebelum mengirim commitment agar proses lebih independen.

### 7.3 Challenger/adjudicator

Pengguna atau verifier dapat mengajukan challenge dengan alasan dan evidence pointer tambahan. Adjudicator menjalankan second-pass review. Jika challenge diterima, pembayaran verifier yang gagal dipotong dari reward; jika ditolak, challenger kehilangan sebagian bond. Pada MVP, adjudicator dapat berupa peran operator yang diawasi dan seluruh keputusan tetap memiliki audit trail.

## 8. Functional requirements

| ID | Requirement | Prioritas |
|---|---|---:|
| FR-01 | Pengguna dapat membuat task dengan prompt, sumber, jumlah verifier, bounty, dan deadline. | P0 |
| FR-02 | Sistem membuat task manifest immutable yang memiliki content hash. | P0 |
| FR-03 | Pengguna dapat membayar escrow melalui smart contract. | P0 |
| FR-04 | Verifier dapat melihat task OPEN dan mengambil task. | P0 |
| FR-05 | Verifier mengirim commitment sebelum membuka hasil. | P0 |
| FR-06 | Verifier menghasilkan claim–evidence graph terstruktur. | P0 |
| FR-07 | Artefak report dan evidence disimpan di 0G Storage. | P0 |
| FR-08 | 0G Compute digunakan untuk extraction dan/atau evidence scoring. | P0 |
| FR-09 | Kontrak menyimpan report pointer, verifier address, verdict hash, dan status. | P0 |
| FR-10 | Sistem menampilkan agreement, conflict, confidence, dan status evidence. | P0 |
| FR-11 | Pengguna dapat mengajukan challenge selama dispute window. | P1 |
| FR-12 | Adjudicator dapat menyelesaikan dispute dengan reason hash. | P1 |
| FR-13 | Payout otomatis dapat dipicu setelah finalisasi. | P0 |
| FR-14 | Pengguna dapat menyalin transaction hash dan Storage object ID. | P0 |
| FR-15 | Sistem menolak data pribadi yang jelas terlihat pada demo input. | P1 |
| FR-16 | Sistem menyediakan API health check dan retry untuk Compute/Storage. | P1 |

## 9. Status machine

| Status | Arti | Transisi berikutnya |
|---|---|---|
| `DRAFT` | Task belum dibayar atau dipublikasikan. | `OPEN`, `CANCELLED` |
| `OPEN` | Task telah di-escrow dan dapat diambil verifier. | `COMMITTING`, `EXPIRED` |
| `COMMITTING` | Verifier mengirim commitment. | `REVEALING`, `EXPIRED` |
| `REVEALING` | Verifier membuka report dan pointer. | `CONSENSUS`, `DISPUTED`, `EXPIRED` |
| `CONSENSUS` | Hasil memenuhi rule agreement. | `FINALIZED` |
| `DISPUTED` | Terdapat challenge aktif. | `ADJUDICATION`, `EXPIRED` |
| `ADJUDICATION` | Adjudicator sedang memeriksa challenge. | `FINALIZED`, `REOPENED` |
| `FINALIZED` | Pembayaran dan attestation dapat dieksekusi. | terminal |
| `EXPIRED` | Deadline terlewati tanpa hasil lengkap. | `REFUND`, `FINALIZED` |
| `CANCELLED` | Task dibatalkan sesuai aturan. | terminal |

## 10. Evidence schema

```json
{
  "taskId": "0x...",
  "claimId": "claim-001",
  "claimText": "The repository released version 1.4.0 on 2026-08-10.",
  "verdict": "SUPPORTED",
  "confidence": 0.91,
  "sources": [{
    "uri": "https://example.org/source",
    "snapshotObjectId": "0g://...",
    "contentHash": "sha256:...",
    "quotedSpan": "Release v1.4.0 — August 10, 2026",
    "retrievedAt": "2026-08-31T00:00:00Z"
  }],
  "verifier": {
    "address": "0x...",
    "modelId": "verifier-a-v1",
    "pipelineVersion": "0.1.0"
  },
  "reasoningSummary": "The source explicitly states the release date.",
  "createdAt": "2026-08-31T00:01:00Z"
}
```

## 11. Non-functional requirements

| Area | Requirement |
|---|---|
| Integrity | Perubahan report menghasilkan content hash baru; report lama tidak dihapus. |
| Reliability | Compute atau Storage failure memiliki retry dengan exponential backoff. |
| Performance | Task sederhana dengan dua verifier menampilkan hasil kurang dari 90 detik pada demo target. |
| Usability | Pengguna baru dapat membuat task tanpa memahami blockchain secara mendalam. |
| Security | Private key server tidak digunakan untuk memegang dana pengguna; gunakan role key terbatas. |
| Transparency | UI selalu menampilkan status onchain/offchain secara berbeda. |
| Observability | Event log memiliki task ID, request ID, verifier ID, latency, dan error code. |
| Portability | Format evidence JSON dapat diunduh dan diverifikasi di luar UI. |

## 12. MVP acceptance criteria

MVP dianggap selesai apabila seluruh skenario berikut berhasil pada testnet.

| Skenario | Kriteria penerimaan |
|---|---|
| Task creation | Wallet membuat task dan escrow; task ID serta manifest hash muncul di UI. |
| Source integrity | Sumber publik disnapshot; content hash dapat dicocokkan dengan manifest. |
| Dual verification | Dua verifier mengirim hasil untuk task yang sama tanpa melihat hasil satu sama lain. |
| Supported claim | Klaim yang didukung diberi verdict `SUPPORTED` dan evidence quoted span. |
| Unsupported claim | Klaim tanpa bukti kuat diberi `INSUFFICIENT_EVIDENCE` atau `CONTRADICTED`. |
| Conflict | Jika verifier berbeda, UI menampilkan konflik dan tidak langsung membayar penuh. |
| Settlement | Task konsensus dapat difinalisasi dan reward dapat ditarik. |
| Auditability | Pengguna dapat membuka report JSON, Storage pointer, dan transaction hash. |
| Failure handling | Simulasi Compute failure menghasilkan retry dan pesan yang dapat dipahami. |
| Reproducibility | Task yang sama dengan snapshot/pipeline sama menghasilkan manifest yang dapat dibandingkan. |

## 13. Success metrics

| Metric | Target demo | Target pasca-MVP |
|---|---:|---:|
| Completed tasks | 20 task publik | 500 task/bulan |
| Task completion rate | ≥90% | ≥97% |
| Evidence coverage | ≥90% klaim memiliki source pointer | ≥95% |
| Conflict visibility | 100% konflik ditampilkan | 100% |
| Median completion time | <90 detik | <30 detik |
| Report reproducibility | 100% sample task dapat direplay | ≥98% |
| Verifier agreement | ≥70% pada benchmark awal | ≥85% pada domain terbatas |

## 14. Roadmap

| Milestone | Durasi | Deliverable |
|---|---:|---|
| M0 — Foundation | 1–2 hari | Repository, wallet connect, network config, sample data, contract skeleton. |
| M1 — Escrow and storage | 2–3 hari | Task creation, escrow, manifest, 0G Storage upload, report viewer. |
| M2 — Verification | 3–4 hari | Dua verifier, commitment/reveal, evidence schema, 0G Compute integration. |
| M3 — Consensus and disputes | 2–3 hari | Agreement rule, dispute window, adjudication state, payout. |
| M4 — Demo hardening | 2 hari | Error handling, seeded tasks, test suite, video, architecture diagram. |
| M5 — Post-event | 2–4 minggu | External verifier onboarding, stake/slashing, domain adapters, SDK. |

## 15. Risiko produk

| Risiko | Dampak | Mitigasi MVP |
|---|---|---|
| Verifier AI sepakat pada jawaban yang salah | Tinggi | Tampilkan evidence dan confidence; gunakan benchmark claims; jangan klaim truth oracle. |
| Sumber berubah atau tidak dapat diakses | Tinggi | Snapshot content/hash, retry, dan status `SOURCE_UNAVAILABLE`. |
| Biaya atau latency Compute | Sedang | Batasi panjang input, cache snapshot, dan pakai sample task kecil. |
| Sybil verifier | Tinggi | Whitelist verifier MVP; fase lanjut memakai stake dan reputation. |
| Smart-contract bug | Tinggi | Minimal contract surface, pause role, unit tests, testnet only. |
| Data sensitif tersimpan publik | Tinggi | Public-data-only demo, redaction, hash-only mode, dan warning UI. |
| Produk terlihat seperti generic AI audit | Sedang | Tekankan evidence market, multi-verifier, commitment/reveal, dan settlement. |

## 16. Keputusan desain yang belum final

Keputusan yang perlu dikonfirmasi sebelum implementasi adalah apakah reward menggunakan native 0G testnet token atau unit kredit internal, apakah verifier pada demo dijalankan sebagai dua worker milik satu tim atau endpoint terpisah, apakah adjudication dilakukan oleh operator atau verifier ketiga, dan apakah scope awal dibatasi pada repository/documentation claims agar evaluasinya objektif.

## 17. Pitch singkat

> ProofRelay turns AI answers into auditable work. Users post a bounty for a claim to be verified; independent AI verifiers produce evidence graphs; 0G stores the immutable artifacts, runs verification workloads, and settles rewards onchain. Agreement earns payment, conflict triggers dispute, and every result remains reproducible.

## 18. Referensi teknis

[1]: [0G Documentation — Understanding 0G](https://docs.0g.ai/introduction/understanding-0g)

[2]: [0G Documentation](https://docs.0g.ai/)

[3]: [0G Bridge by AKINDO](https://app.akindo.io/wave-hacks/Z4MlX4vreI72ol6pd?tab=submissions)

[4]: [0G Ecosystem Growth Program](https://0g.ai/blog/0g-ecosystem-program)
