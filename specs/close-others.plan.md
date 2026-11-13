# Plan: Close Others for Request Tabs

Tanggal: 2026-11-12
Status: Implemented; desktop release build succeeded; user reported manual self-testing OK on 2026-11-12. Regression definitions authored but not executed. No per-case checklist results were provided; unchecked cases below are not individually verified.

## Tujuan dan acceptance criteria

Tambahkan menu **Close Others** pada context menu tab. Pertahankan tab yang diklik kanan dan tutup seluruh tab lain dalam workspace aktif. Tab yang dipertahankan menjadi aktif setelah operasi berhasil, termasuk bila sebelumnya bukan tab aktif.

- Nonaktifkan menu jika hanya ada satu tab atau operasi tab/workspace yang konflik sedang berjalan.
- Jika seluruh target bersih dan tidak memiliki eksekusi aktif, langsung proses penutupan tanpa dialog.
- Jika ada target dengan perubahan belum disimpan, tampilkan satu dialog yang hanya mencantumkan request target yang dirty.
- Pilihan dialog: **Cancel**, **Discard and Close Others**, **Save All and Close Others**.
- Jika target memiliki eksekusi aktif, tampilkan konfirmasi pembatalan meskipun tidak ada draft dirty. Gunakan **Cancel** dan **Cancel Requests and Close Others** untuk kasus ini, agar request berjalan tidak dihentikan diam-diam.
- Dialog dirty juga menampilkan jumlah eksekusi target yang akan dibatalkan serta keterangan bahwa server mungkin sudah memproses request tersebut.
- Draft, response, dan eksekusi tab yang dipertahankan tidak ikut disimpan, dibuang, atau dibatalkan. Dirty pada tab tersebut saja tidak memicu dialog.
- Kegagalan persiapan, Save, pembatalan, atau penyimpanan session menghentikan penutupan; tab/draft tetap terbuka agar pengguna dapat mencoba lagi atau membatalkan.
- Penutupan tab tidak menghapus request, execution history, atau saved-response snapshot di database.

## Alur operasi

1. Tangkap `keepId`, daftar target, dan identitas workspace saat pengguna memilih menu. Validasi tab masih tersedia dan tidak ada save, recovery, loading, atau mutasi yang konflik.
2. Untuk dialog, tampilkan daftar dirty dan jumlah eksekusi dari target tersebut. Cancel sebelum konfirmasi tidak mengubah tab, active selection, draft, atau execution state.
3. Saat pengguna mengonfirmasi, atau saat jalur langsung dimulai, aktifkan busy guard dan validasi ulang target/workspace. Cegah interaksi baru yang mengubah tab, draft, Send, atau workspace selama proses async. Sertakan operasi ini dalam modal/shortcut/transition guards yang ada, termasuk jalur tanpa dialog.
4. Untuk Save All, simpan hanya target dirty. Tunggu semuanya berhasil dan pastikan target tidak lagi dirty sebelum melanjutkan. Bila satu gagal atau muncul edit baru, hentikan tanpa menutup tab. Save yang sudah berhasil tetap tersimpan; tidak ada rollback lintas-request yang diklaim.
5. Batalkan eksekusi hanya pada target menggunakan operasi cancellation yang menunggu acknowledgment. Jangan gunakan `cancelAll`, dan jangan hapus execution state melalui `forget` sebelum seluruh persiapan berhasil.
6. Siapkan session hasil akhir berisi tab yang dipertahankan, active ID yang sama, dan view-nya. Persist melalui antrian session store sebelum membuang draft atau menghapus tab dari memori.
7. Setelah penyimpanan session berhasil, commit penutupan dalam satu operasi sinkron: discard hanya target bila dipilih, bersihkan target execution/restore cache dan pending restore identity, hapus target tabs/editor state, lalu aktifkan tab yang dipertahankan.
8. Tutup dialog dan lepaskan busy guard. Pastikan scroll bar tab menampilkan tab yang dipertahankan dan menghitung ulang overflow.

## Perubahan implementasi

### 1. Batch close pada workspace store

Area: `frontend/src/stores/workspace.ts` dan regresinya.

- Tambahkan operasi batch yang menerima tab yang dipertahankan dan kumpulan target terverifikasi. Pisahkan persiapan session akhir dari commit perubahan memori.
- Gunakan queue/cache persistensi session yang sudah ada, termasuk penanganan error dan invalidasi cache, bukan write paralel langsung dari komponen.
- Tahan autosave session lama selama persiapan/commit sehingga timer atau queued write tidak mengembalikan tab yang sudah ditutup. Kuras write terdahulu sebelum menulis session akhir; jadwalkan ulang state saat ini bila operasi dibatalkan/gagal.
- Hindari menutup satu per satu dengan `closeClean`: fungsi itu memindahkan active tab serta menjadwalkan session untuk setiap penutupan dan tidak mewakili commit batch.
- Validasi semua target sebelum mutasi sinkron. Jangan sisakan tahap async yang masih dapat gagal setelah discard draft dimulai.

Selesai ketika: daftar tab dan active ID berubah bersama setelah semua precondition berhasil; error sebelumnya mempertahankan tab/draft.

### 2. Koordinasi execution state

Area: `frontend/src/stores/execution.ts` dan regresinya.

- Reuse cancellation per ID dan tunggu acknowledgment semua target yang relevan sebelum melanjutkan. Jika satu gagal, tunggu operasi cancellation lain selesai sebelum melepas lock atau mengizinkan retry.
- Bersihkan state hasil dan restore target hanya saat commit, menggunakan invalidasi generation yang sudah ada agar late restore tidak menghidupkan kembali tab tertutup.
- Pertahankan seluruh execution state tab yang dipertahankan, termasuk request aktif.
- Pembatalan yang telah berhasil tidak dapat di-undo jika langkah berikutnya gagal. Jelaskan kegagalan secara akurat; jangan menyatakan seluruh efek operasi telah di-rollback.

Selesai ketika: cancellation hanya menyentuh target dan kegagalan tidak membuang draft atau menutup sebagian tab.

### 3. Context menu dan dialog

Area: `frontend/src/app/WorkspaceApp.vue`; komponen dialog khusus bila itu membuat koordinasi lebih jelas.

- Tambahkan action `close-others` setelah Close tab, dengan label **Close Others** dan disabled state yang sesuai.
- Tambahkan handler eksplisit sebelum cabang move-left/right agar action baru tidak jatuh ke logika reorder.
- Ikuti pola visual/focus/error QuitDialog untuk dialog **Close Other Tabs**. Reuse primitives dan perilaku Save/Discard/Cancel; jangan panggil `finishQuit`, `cancelQuit`, atau persistensi window/preferences milik Quit.
- Batasi daftar dirty dan pesan cancellation pada target. Escape/backdrop mengikuti Cancel saat idle dan ditolak saat busy.
- Error tetap muncul di dialog dan tombol kembali tersedia untuk retry/Cancel. Jalur langsung melaporkan error melalui area error aplikasi yang sudah ada.
- Sinkronkan interaksi dengan modal/keyboard/sidebar/workspace guards. Bila Quit diminta saat batch berjalan, tunggu batch selesai sebelum membuka alur Quit; jangan jalankan keduanya bersamaan.

Selesai ketika: target berasal dari tab yang diklik kanan, semua state dialog konsisten, dan tab yang dipertahankan tidak berubah sebelum operasi berhasil.

### 4. Dokumentasi dan pemeriksaan

- Perbarui README/CLAUDE.md secara singkat tentang Close Others, scope unsaved confirmation, dan request cancellation.
- Pertahankan perubahan scroll-tab yang sudah ada di working tree; fitur batch close harus bekerja bersama resize/overflow/active-tab reveal.
- Jalankan typecheck, lint, frontend build, dan diff whitespace check. Perubahan ini frontend-only; tidak membutuhkan migrasi database atau command backend baru.
- Tulis regresi yang diperlukan tanpa menjalankan suite, aplikasi, atau browser/native automation, sesuai pilihan pengguna untuk self-testing manual.
- Pisahkan laporan static/build pass dari definisi regresi yang belum dijalankan. Jangan mengubah laporan QA historis atau mengklaim restart acceptance.

## Definisi regresi yang ditulis

Utamakan seam integrasi WorkspaceApp dengan memory API, execution fixture, dan deferred promises yang sudah digunakan di repo. Tambahkan coverage store hanya untuk kontrak session batch yang tidak terjangkau jelas dari seam tersebut.

- Close Others dari tab aktif maupun tab nonaktif menyisakan tab yang diklik kanan dan mengaktifkannya.
- Satu tab menghasilkan menu disabled; beberapa tab bersih ditutup tanpa dialog.
- Dirty pada tab yang dipertahankan tidak ikut Save/Discard maupun daftar dialog.
- Beberapa target dirty menghasilkan satu dialog; Cancel mempertahankan semuanya.
- Save All menyimpan semua target sebelum ada penutupan; kegagalan Save berikutnya mempertahankan semua tab dan draft yang belum tersimpan.
- Discard tidak membuang draft sebelum cancellation dan final session berhasil.
- Cancellation hanya menargetkan tab lain, menunggu acknowledgment, dan tidak membatalkan request tab yang dipertahankan.
- Kegagalan cancellation/session memungkinkan retry tanpa partial close; tidak ada janji mengembalikan Save atau cancellation yang sudah sukses.
- Session akhir berisi satu tab, active ID, dan view yang benar; antrian/timer session lama tidak menimpa hasilnya.
- Late restore target diabaikan setelah commit; membuka ulang request tetap bisa memuat saved response.
- Busy guard mencegah double submit, edit/Send/open/close/move/workspace switch, dan konflik Quit selama batch async.

## Checklist self-testing manual

- [ ] Buka beberapa tab bersih; klik kanan tab nonaktif → Close Others. Hanya tab itu tersisa dan aktif.
- [ ] Buat dirty pada beberapa tab lain; pastikan satu dialog memuat hanya request terdampak. Cancel mempertahankan tab, draft, dan active selection.
- [ ] Save All and Close Others menyimpan seluruh target sebelum menutupnya; reopen request menunjukkan perubahan tersimpan.
- [ ] Discard and Close Others membuang hanya draft target; tab yang dipertahankan tetap memiliki draft/response sebelumnya.
- [ ] Jalankan request lambat pada target dan tab yang dipertahankan. Dialog menjelaskan cancellation; hanya request target dibatalkan.
- [ ] Jika semua target bersih tetapi ada request berjalan, konfirmasi cancellation tetap muncul.
- [ ] Bila mensimulasikan Save/cancel/session failure, gunakan fixture atau workspace QA; pastikan tab/draft tetap ada dan retry/Cancel bekerja.
- [ ] Saat proses busy, double click/shortcut/workspace switch/Quit tidak memulai operasi yang konflik.
- [ ] Dengan tab overflow, Close Others menghilangkan panah scroll setelah satu tab muat; tab yang dipertahankan terlihat.
- [ ] Quit/relaunch setelah close sukses; session hanya membuka tab yang dipertahankan. Request yang ditutup masih tersedia di sidebar dan saved response pulih saat dibuka kembali.

## Batas dan risiko

- Save beberapa request bukan transaksi tunggal: Save terdahulu tetap berlaku bila Save berikutnya gagal.
- Cancellation tidak membatalkan efek request yang sudah diterima server. Cancellation target yang sukses tetap berlaku jika persistensi session kemudian gagal.
- Respons IPC session yang hilang bisa terjadi setelah write di backend committed. Pertahankan tab/draft di memori, tampilkan error dan izinkan retry; jangan mengklaim disk pasti belum berubah. Reuse mekanisme invalidasi cache/retry session.
- Tab yang ditutup bukan request yang dihapus; snapshot response di disk tetap ada. Clone tidak menyalin snapshot.
- Di luar scope: Close All, Close Tabs to Left/Right, multi-select tab closing, undo close, perubahan Quit flow, dan perubahan backend/schema.
