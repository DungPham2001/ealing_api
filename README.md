# Ealing Holdings — API

Node.js (Express 4) + MongoDB (Mongoose 8) cho app Flutter "Ealing Holdings". Hợp đồng API: [docs/API cho BE - Ealing Holdings.md](docs/API%20cho%20BE%20-%20Ealing%20Holdings.md).
Cùng kiến trúc với `ealice_investment_api` / `eal_investment_api`: một engine CRUD chung cho 32 resource, entry Vercel ở `api/`, test trên MongoDB in-memory.

```bash
cp .env.example .env     # đặt MONGODB_URI (database: ealing_holdings, cùng cluster Atlas với các app khác)
npm install
npm run db:init          # tạo database, collection, index (chạy lại an toàn)
npm run dev              # http://localhost:4000  -> /health, /v1
npm test                 # replica set in-memory (dùng mongod local nếu có)
```

## Kết nối MongoDB (giống các API khác trong API_Web)

* `MONGODB_URI` trong `.env` — một cluster Atlas dùng chung, **mỗi app một database** (`ealing_holdings`).
* Local/server: `src/server.js` gọi `mongoose.connect` rồi mới `listen`.
* Vercel: `api/index.js` cache kết nối giữa các lần gọi (warm function dùng lại), `autoIndex=false` nên **phải chạy `npm run db:init` một lần** với đúng `MONGODB_URI`.
* Xóa dây chuyền chạy trong transaction (cần replica set — Atlas có sẵn; mongod đơn lẻ tự rơi về không-transaction).

## Cấu trúc

| Thư mục | Nội dung |
|---|---|
| `src/resources/` | 32 resource: trường, enum, required, quy tắc xóa (`cascade/unlink/restrict/none`), trường 🧮 |
| `src/core/` | Engine: validate (+PII), create/update/delete (+version, khóa kỳ, cascade, transaction), list/search/cursor, router |
| `src/services/` | `queue.js` (Queue tự sinh §6), `jobs.js` (job hằng ngày), `income.js` (doanh thu auto), `actions.js` (các `POST …/{id}/<action>`), `reports.js`, `export.js`, `content.js` |
| `src/middleware/` | context (requestId), rate limit theo IP (lưu ở Mongo), lỗi `{error:{code,message,fields,requestId}}` |
| `scripts/` | `db-init`, `set-setting` (ngưỡng + chốt kỳ), `set-content` (nội dung công khai) |

## Quyết định khi tài liệu chưa nói rõ

* **Không header nào** (không token, không `Idempotency-Key`). Chống ghi đè dùng `version` trong body.
* **Tiền write-only**: nhận `{amountMinor, currency}`, lưu nguyên, **không bao giờ** có trong response/CSV/PDF. Báo cáo chỉ tính ra %, đếm, chỉ số.
* **`PATCH`** chỉ tăng `version` khi có giá trị thật sự đổi; thiếu `version` → `400`, sai → `409 version_conflict` kèm `error.current`.
* **Trạng thái 🧮** (lease, rent, loan, vendor, PM, utility, close, asset-class…) được tính khi đọc **và** lưu lại khi ghi + job hằng ngày (để lọc/`stats` đúng). Job không tăng `version`.
* **Xóa**: Property/Unit/… cascade theo mục 5. **Entity bị chặn** (`409 has_dependents`, kèm `blockedBy`) nếu còn tài sản, dự án, khoản vay, giao dịch nội bộ, dòng tiền, doanh thu hoặc pháp nhân con (đề xuất của mục 8.1). `GET /v1/<resource>/{id}/delete-impact` cho hộp thoại xác nhận.
* **Kỳ đã chốt**: do EALING đặt ngoài app: `npm run setting -- closedThrough=2026-09` (mọi tháng ≤ giá trị này bị khóa → `409 period_locked`). `locked` là trường tính.
* **Ngưỡng** (hết hạn hợp đồng 60 ngày, bảo hành 60 ngày, đáo hạn 12 tháng, Top N, tăng tiện ích 20%…) đọc từ collection `settings`, sửa bằng `npm run setting -- key=value`, không hard-code.
* **Rate limit theo IP** lưu trong Mongo (hợp serverless): đọc 60/phút, ghi 20/phút, tạo 300/ngày, xuất 30/ngày, vi phạm nhiều → khóa tạm. Chỉnh bằng biến `RATE_*` trong `.env`; `RATE_LIMIT=off` để tắt. Nên thêm WAF/CDN ở hạ tầng như tài liệu đề xuất.
* **Job hằng ngày** `GET /v1/jobs/daily` (Vercel Cron 09:00 UTC): làm mới trạng thái, sinh Work Order từ lịch bảo trì đến hạn, đồng bộ Queue tự sinh. Đặt `CRON_SECRET` để chỉ cron gọi được.
* **Queue tự sinh** duy nhất theo `source.id + type` (unique index một phần), tự `done` khi nguồn đã xử lý, bị xóa theo khi xóa bản ghi nguồn; mục thủ công giữ nguyên.
* **Doanh thu tự động** (`income-entries.source=auto`) được giữ đồng bộ với `rent-collections` và `cash-flows`; mục thủ công không bị đụng.
* **Nội dung công khai**: `/v1/public/company` có mặc định từ tài liệu; EALING cập nhật bằng `npm run content -- company file.json`. `scale` chỉ hiện khi `scale.approved=true`, lãnh đạo chỉ hiện khi `public=true`. `/v1/public/templates` có sẵn 8 mẫu nhưng `downloadUrl=null` đến khi EALING nhập link thật.
* **PDF xuất báo cáo** dùng font chuẩn Helvetica nên tiếng Việt bị bỏ dấu trong PDF (CSV giữ nguyên dấu). Muốn có dấu cần nhúng font Unicode.
* `unitMap`: thêm ký tự `O` cho đơn vị `offline` (spec chỉ liệt kê L/V/S/R).

### Trường thêm ngoài spec (tùy chọn, không bắt buộc với app)

`work-orders.equipmentCode` (đếm `repairCount` của thiết bị), `work-orders.sourceType/sourceCode` (lệnh do hệ thống sinh), `pm-schedules.firstDueAt` (ngày đến hạn đầu tiên khi chưa có `lastDoneAt`), `intercompany-entries.isCounterpart`, `deals.propertyCode` / `development-projects.propertyCode` (tài sản được tạo khi đóng/hoàn tất). Action `deals/{id}/close` (mua vào) cần `entityCode` trong body để tạo tài sản; `deals/{id}/convert-to-development` cần `entityCode`.

## Deploy (Vercel)

`vercel.json` chuyển mọi request vào `api/index.js`. Đặt `MONGODB_URI` (và `TIMEZONE`, `CRON_SECRET`), chạy `npm run db:init` một lần.
