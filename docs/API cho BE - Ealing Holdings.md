# Ealing Holdings – Tài liệu API cho Backend

Phiên bản tài liệu: 1.0 · 07/11/2026 · Dựa trên spec `docs/Mô tả ứng dụng Ealing Holdings…md` (mục 5) và giao diện app Flutter hiện tại.

Tài liệu này mô tả **tài nguyên, model, quy tắc** để BE viết API. App hiện chạy bằng dữ liệu giả trong bộ nhớ (`lib/data/mock_data.dart`, `lib/data/repo.dart`); khi API xong, app thay nguồn dữ liệu sang các endpoint dưới đây.

---

## 0. Đọc trước (5 điều quan trọng nhất)

1. **Không đăng nhập, mọi thứ công khai.** Không có tài khoản/vai trò. Mọi người dùng app đều Tạo/Xem/Sửa/Xóa dữ liệu nghiệp vụ dùng chung. Vì vậy BE phải tự bảo vệ: giới hạn tốc độ theo IP, kiểm tra PII, giới hạn kích thước/số lượng (mục 2.8).
   **Quy ước: mọi API không yêu cầu truyền header tùy biến nào** (không token, không mã cài đặt, không `Idempotency-Key`) – chỉ cần `Content-Type: application/json` khi có body (mục 2.2).
2. **Trường số tiền là WRITE-ONLY.** Chỉ nhận ở `POST`/`PATCH`; **không bao giờ** trả giá trị gốc về app (kể cả trong CSV/PDF). BE tính sẵn và trả **số đếm, %, chỉ số, trạng thái, mã, ngày**. Các trường này đánh dấu `🔒 WO` trong tài liệu.
3. **Xóa là xóa hẳn**, không soft-delete, không thùng rác, không lịch sử sửa/xóa. Xóa bản ghi cha thì xóa luôn bản ghi con (bảng cascade ở mục 5).
4. **Chống ghi đè đồng thời:** mỗi bản ghi có `version`; `PATCH` phải gửi `version` cũ, sai thì trả `409 version_conflict`.
5. **Không có dữ liệu cá nhân:** không có trường tên người, liên hệ cá nhân, số tài khoản, mã số thuế… Pháp nhân ghi bằng mã; tài sản có người ở chỉ có thành phố + ZIP; đơn vị cho thuê chỉ có mã đơn vị.

---

## 1. Bản đồ: phân hệ trong app → tài nguyên API

| Màn hình app (module id) | Tài nguyên chính | Ghi chú |
| --- | --- | --- |
| Pháp nhân (`entities`) | `/v1/entities` | |
| Danh mục tài sản (`portfolio`) | `/v1/asset-classes` | |
| Sổ cái giữa pháp nhân (`intercompany`) | `/v1/intercompany-entries`, `/v1/intercompany-pairs` | Danh sách trong app là **cặp** pháp nhân (đọc), CRUD trên **giao dịch** |
| Kế hoạch thoái vốn (`exit`) | `/v1/exit-plans` | |
| Tài sản (`properties`) | `/v1/properties` | |
| Hồ sơ tài sản (`docs`) | `/v1/property-records` | Chỉ mục, không lưu tệp |
| Đơn vị cho thuê (`units`) | `/v1/units` | |
| Hợp đồng thuê (`leases`) | `/v1/leases` | |
| Thu tiền thuê (`rent`) | `/v1/rent-collections` | |
| Phễu cho thuê (`funnel`) | `/v1/leasing-funnel` | |
| Bảo trì (`maintenance`) | `/v1/work-orders` | |
| Bảo trì phòng ngừa (`preventive`) | `/v1/pm-schedules` | |
| Nhà thầu (`contractors`) | `/v1/vendors` | |
| Sổ thiết bị & bảo hành (`equipment`) | `/v1/equipment` | |
| Theo dõi tiện ích (`utilities`) | `/v1/utilities` | |
| Ứng phó bão (`storm`) | `/v1/storm-plans` | |
| Dự án cải tạo (`renovation`) | `/v1/renovation-projects` | |
| Kiểm tra tài sản (`inspection`) | `/v1/inspections` | |
| Dự án phát triển (`development`) | `/v1/development-projects` | |
| Giao dịch đầu tư (`deals`) | `/v1/deals` (+ checklist) | Kanban |
| Dòng tiền & ngân sách (`cashflow`) | `/v1/cash-flows`, `/v1/budgets` | |
| Khoản vay (`loans`) | `/v1/loans` | |
| Revenue (`revenue`) | `/v1/income-entries`, `/v1/revenue-targets`, `/v1/reports/noi` | |
| Đóng sổ cuối tháng (`closing`) | `/v1/month-end-closes` | |
| Queue (`queue`) | `/v1/queue-items` | Kanban |
| Việc cần làm (`todos`) | `/v1/tasks` | |
| Đối tác (`partners`) | `/v1/partners` | |
| Nhà cung cấp dịch vụ (`vendors` trong mock) | `/v1/service-providers` | |
| Báo cáo & phân tích (`reports`) | `/v1/reports/*` | Chỉ đọc, tính ở server |
| Home | `/v1/reports/dashboard`, `/v1/reports/highlights` | Chỉ đọc |
| Timeline | `/v1/timeline` | Chỉ đọc, gộp từ nhiều nguồn |
| Toolkit → Kịch bản đã lưu | `/v1/scenarios` | CRUD |
| Giới thiệu doanh nghiệp, Liên hệ | `/v1/public/company` | Chỉ đọc, EALING cập nhật ngoài app |
| Mẫu biểu tải về | `/v1/public/templates` | Chỉ đọc |

> **Đã bỏ khỏi app (so với spec):** chức năng "Báo cáo nội dung" (`/v1/content-reports`) và cài đặt "Tên hiển thị". BE **chưa cần** làm `content-reports`; trường `createdByName` vẫn nhận nhưng app hiện gửi giá trị cố định (xem 3.1). Nếu sau này thêm lại thì làm theo spec 5.3.

---

## 2. Quy ước chung

### 2.1 Chung
- REST + JSON, UTF-8, **chỉ HTTPS**. Base URL: `https://api.<domain>/v1`.
- Thời gian: ISO-8601 UTC (`2026-11-07T09:41:00Z`). Ngày thuần: `YYYY-MM-DD`. Kỳ tháng: `YYYY-MM`.
- Tỷ lệ phần trăm: số thập phân trong khoảng 0–100 (ví dụ `61.2`), lưu tối đa 2 chữ số thập phân. Hệ số (DSCR): số thập phân, ví dụ `1.42`.
- Tiền (chỉ khi **nhận vào**): `{ "amountMinor": 240000000, "currency": "USD" }` – số nguyên theo đơn vị nhỏ nhất (cent).
- Khóa JSON: `camelCase`. Giá trị enum: `snake_case` (bảng nhãn tiếng Việt ở mục 4; app tự map sang nhãn hiển thị).
- Mã bản ghi (`code`): **server tự sinh**, duy nhất theo tài nguyên, dễ đọc (ví dụ `TS-101`, `HD-2406`, `BT-2311`). Khóa kỹ thuật là `id` (UUID).

### 2.2 Header: không bắt buộc header nào
**Tất cả API không cần truyền header tùy biến.** Không có token, không có mã cài đặt, không có chứng thực, không có `Idempotency-Key`, không có header phiên bản app.
- Chỉ cần header HTTP chuẩn: `Content-Type: application/json` với request có body, và `Accept: application/json`.
- Mọi thông tin cần thiết đều nằm ở **đường dẫn, query string hoặc body**: chống ghi đè dùng trường `version` trong body (2.5); lọc/phân trang dùng query (2.4).
- BE nhận diện client chỉ bằng **địa chỉ IP** (để giới hạn tốc độ) – xem 2.8.
- Hệ quả: không có cơ chế chống tạo trùng bằng `Idempotency-Key`. Nếu app gửi lặp do mạng chập chờn, BE có thể chống trùng bằng ràng buộc nghiệp vụ (ví dụ mục Queue tự sinh duy nhất theo `source`+`type`), còn bản ghi thủ công trùng thì người dùng tự xóa.

### 2.3 Khuôn response
Danh sách:
```json
{
  "data": [ { "id": "…", "code": "TS-101" } ],
  "page": { "limit": 20, "nextCursor": "eyJ…", "total": 6 },
  "asOf": "2026-11-07T09:41:00Z"
}
```
Một bản ghi: `{ "data": { … }, "asOf": "…" }`. `asOf` để app hiển thị "Đã đồng bộ lúc…" và khi mất mạng.

Lỗi:
```json
{
  "error": {
    "code": "validation_failed",
    "message": "Dữ liệu không hợp lệ",
    "fields": [ { "field": "title", "code": "required" } ],
    "requestId": "req_8f2…"
  }
}
```
| HTTP | `error.code` | Khi nào |
| --- | --- | --- |
| 400 | `validation_failed` | Thiếu/sai kiểu/ngoài khoảng giá trị |
| 404 | `not_found` | |
| 409 | `version_conflict` | `version` gửi lên khác bản hiện tại. Body kèm **bản hiện tại** trong `error.current` để app tải lại |
| 409 | `period_locked` | Sửa/xóa bản ghi thuộc kỳ đã chốt |
| 409 | `has_dependents` | (nếu BE chọn chặn thay vì cascade) |
| 413 | `payload_too_large` | |
| 422 | `pii_detected` | Chuỗi giống email/SĐT/thẻ/SSN/tài khoản/MST ở trường không cho phép. `fields[].kind` ∈ `email, phone, card, ssn, account, tax_id` |
| 429 | `rate_limited` | Kèm `Retry-After` (giây) |
| 5xx | `internal_error` | Không lộ chi tiết nội bộ |

### 2.4 Danh sách: lọc, tìm, sắp xếp, phân trang
Mọi `GET /v1/<resource>`:
- `limit` (mặc định 20, tối đa 100), `cursor` (con trỏ từ `page.nextCursor`).
- `q`: tìm theo `code`, `title/name`, mô tả ngắn, `status` (không phân biệt hoa thường/dấu).
- `status`: một hoặc nhiều giá trị, ngăn cách dấu phẩy (`status=active,suspended`).
- `sort`: `-updatedAt` (mặc định), `code`, hoặc trường riêng; tiền tố `-` là giảm dần.
- Lọc theo quan hệ: `entityCode`, `propertyCode`, `unitCode`… (ghi ở từng tài nguyên).
- Số đếm theo trạng thái cho thanh tóm tắt ở đầu màn danh sách: `GET /v1/<resource>/stats` → `{ "total": 6, "byStatus": { "active": 3, "expiring": 1 } }` (áp dụng cho **mọi** tài nguyên có `status`).

### 2.5 Ghi dữ liệu
- `POST /v1/<resource>` → `201` + bản ghi đầy đủ (kèm `code`, `version: 1`).
- `PATCH /v1/<resource>/{id}` → body = các trường cần ghi đè **+ `version` bắt buộc**. Trả `200` + bản ghi mới (`version` + 1). Trường không gửi thì giữ nguyên. **Không lưu giá trị cũ/lịch sử.**
- `DELETE /v1/<resource>/{id}` → `204`. Xóa hẳn + cascade (mục 5). Không cần body.
- Trường **WRITE-ONLY** trong `PATCH`: muốn đổi thì gửi lại giá trị mới; không gửi = giữ nguyên giá trị đang lưu trên server.
- Các thao tác nghiệp vụ không phải CRUD thuần dùng `POST /…/{id}/<action>` (nhận việc, chuyển bước, gia hạn…) – xem từng mục.

### 2.6 Trường chung của mọi bản ghi nghiệp vụ (`BaseRecord`)
```ts
interface BaseRecord {
  id: string;                 // UUID
  code: string;               // server sinh, vd "TS-101"
  version: number;            // bắt đầu 1, +1 mỗi lần PATCH
  status: string;             // enum riêng từng tài nguyên (mục 4)
  note?: string | null;       // ≤ 500 ký tự, qua bộ lọc PII
  ownerName?: string | null;  // "người phụ trách" – tên TỰ DO, ≤ 40 ký tự, KHÔNG xác thực
  createdByName?: string | null; // tên hiển thị thiết bị – tự do, ≤ 40, KHÔNG xác thực
  createdAt: string;          // DateTime UTC
  updatedAt: string;          // DateTime UTC
}
```
Ở các model bên dưới chỉ liệt kê **trường riêng**; `BaseRecord` mặc định có ở tất cả. Chú giải:
- `🔒 WO` = write-only (chỉ nhận, không trả).
- `🧮` = server tính, **chỉ trả**, client không gửi.
- `?` = tùy chọn.

### 2.7 Kỳ đã chốt (period lock)
`rent-collections`, `cash-flows`, `income-entries`, `month-end-closes` có `locked: boolean` (🧮). Kỳ chốt **chỉ do EALING chốt trên trang quản trị** (API riêng, ngoài phạm vi app). Bản ghi `locked=true`: `PATCH`/`DELETE` → `409 period_locked`.

### 2.8 Kiểm tra dữ liệu & chống lạm dụng
- **PII filter** trên mọi trường chuỗi tự do (`title, name, note, description, ownerName, createdByName, storageNote…`): từ chối chuỗi giống email, số điện thoại, số thẻ (Luhn), SSN, số tài khoản, mã số thuế. Ngoại lệ có chủ đích: `companyEmail`, `companyPhone`, `website` ở `vendors`/`partners` (email/điện thoại **chung của doanh nghiệp**).
- Giới hạn độ dài: tiêu đề ≤ 120, mô tả ngắn ≤ 200, ghi chú ≤ 500, tên tự do ≤ 40.
- Ngày hợp lý (không trước 1990, không sau +50 năm), số ≥ 0 khi là số lượng/tiền, % trong 0–100.
- Rate limit **theo IP** (vì không có header định danh): gợi ý 60 request/phút đọc, 20/phút ghi; giới hạn số bản ghi tạo/ngày/IP (BE chọn con số, cấu hình được). Xuất báo cáo giới hạn số lần/ngày. Nên đặt thêm WAF/CDN rule chống bot ở tầng hạ tầng.
- Tạm khóa IP vi phạm (trả `429`/`403`).
- **Không ghi log nội dung bản ghi**; chỉ log kỹ thuật tối thiểu (IP, số lần gọi, requestId).
- Không có upload tệp ở bản đầu.

### 2.9 Danh mục enum và giới hạn
- `GET /v1/meta` → `{ enums, limits }` – danh mục enum + nhãn (tránh lệch nhãn giữa app và BE) và giới hạn hiện hành (độ dài, rate). Không cần header.
- Không có bước đăng ký/chứng thực phiên: app gọi thẳng các API.

---

## 3. Model chi tiết theo tài nguyên

> Ký hiệu kiểu: `Pct` = số 0–100; `Date` = `YYYY-MM-DD`; `DateTime` = ISO UTC; `Code` = mã tham chiếu (ví dụ `"PN-A"`); `Count` = số nguyên ≥ 0.
> Cột "App hiển thị" ghi lại nội dung thẻ trong app để BE biết trường nào cần trả/tính.

### 3.1 Cấu trúc & danh mục

**Entity – `/v1/entities`** (Pháp nhân; xóa kèm: không cascade nghiệp vụ, xem mục 5)
```ts
interface Entity extends BaseRecord {
  type: 'llc' | 'inc' | 'other';
  state: string;                 // mã tiểu bang 2 ký tự, vd "FL"
  purpose: 'hold_real_estate' | 'invest' | 'operate' | 'develop';
  formedAt: Date;
  status: 'active' | 'suspended' | 'dissolved';
  parentCode?: Code | null;      // pháp nhân mẹ
  parentOwnershipPct?: Pct | null;
  propertyCount: Count;          // 🧮
  projectCount: Count;           // 🧮
}
```
Ràng buộc: `code` dạng `PN-<chữ>`; không vòng cha-con; không có trường tên thành viên/người quản lý/MST. Thêm `GET /v1/entities/tree` → cây `{ code, type, ownershipPct, children[] }`.

**AssetClass – `/v1/asset-classes`** (Danh mục tài sản)
```ts
interface AssetClass extends BaseRecord {
  classKey: 'rental_real_estate' | 'land' | 'developing_real_estate' | 'other_investment' | 'cash_equivalent';
  entityCode?: Code | null;
  estimatedValue: Money;         // 🔒 WO – tổng hợp, ghi tay
  valueUpdatedAt: Date;
  targetWeightPct: Pct;
  toleranceBandPct: Pct;         // ± khoảng cho phép
  actualWeightPct: Pct;          // 🧮
  deviationPts: number;          // 🧮 điểm %, có dấu
  liquidityMonths?: number;      // 🧮 chỉ nhóm cash_equivalent
  status: 'within' | 'slight' | 'high';  // 🧮 Trong khoảng / Lệch nhẹ / Lệch nhiều
}
```

**IntercompanyEntry – `/v1/intercompany-entries`** (giao dịch nội bộ; ghi một bên thì server tự tạo bản ghi **đối ứng** chờ bên kia xác nhận)
```ts
interface IntercompanyEntry extends BaseRecord {
  creditEntityCode: Code;
  debitEntityCode: Code;         // khác creditEntityCode
  txnType: 'capital_transfer' | 'expense_paid_on_behalf' | 'shared_cost_allocation' | 'repayment';
  date: Date;
  amount: Money;                 // 🔒 WO
  description?: string;          // ≤ 80
  counterpartConfirmed: boolean; // 🧮
}
// xác nhận phía đối ứng: POST /v1/intercompany-entries/{id}/confirm   body: { amount: Money }  (nhập số tương ứng)
```
**IntercompanyPair – `GET /v1/intercompany-pairs`** (🧮 chỉ đọc; đây là thứ app liệt kê)
```ts
interface IntercompanyPair {
  code: string;                  // vd "SC-AB"
  creditEntityCode: Code; debitEntityCode: Code;
  txnTypes: string[];            // các loại giao dịch hiện có
  reconcileStatus: 'match' | 'mismatch';   // Khớp / Lệch
  deviationPct: Pct;             // độ lệch %
  pendingConfirmCount: Count;    // chưa được bên kia xác nhận
  txnCount: Count;
  lastDate: Date;
}
```
Giao dịch chưa khớp khi đóng sổ → tự sinh `QueueItem(type=closing)`.

**ExitPlan – `/v1/exit-plans`** (Kế hoạch thoái vốn; Kanban theo `lifecycleStage`)
```ts
interface ExitPlan extends BaseRecord {
  propertyCode: Code;            // 1 tài sản – 1 kế hoạch
  strategy: 'hold' | 'refinance' | 'sell' | 'renovate_then_sell';
  holdYears: number;
  targetExitYear: number;
  trigger?: { metric: 'cap_rate' | 'ltv'; op: 'gte' | 'lte'; valuePct: Pct } | null;
  priority: number;              // 1 = ưu tiên cao nhất
  lifecycleStage: 'new' | 'stabilized' | 'value_add' | 'prep_sale' | 'sold';
  triggerMet: boolean;           // 🧮
}
```
Chuyển `lifecycleStage` sang `prep_sale` → có thể tạo cơ hội bán: `POST /v1/exit-plans/{id}/create-sale-deal` (tạo `Deal` kind=`disposition`).

### 3.2 Bất động sản

**Property – `/v1/properties`** (Tài sản)
```ts
interface Property extends BaseRecord {
  name: string;
  type: 'multifamily' | 'single_family' | 'commercial' | 'mixed' | 'land';
  entityCode: Code;
  city: string; zip: string;                  // nhà ở có người ở: CHỈ có city + zip
  fullAddress?: string | null;                // CHỈ cho type=commercial|land
  yearBuilt?: number;
  areaSqm?: number;
  unitCount: Count;
  purchasePrice: Money;                       // 🔒 WO
  purchaseDate?: Date;
  estimatedValue: Money;                      // 🔒 WO
  status: 'owned' | 'managed' | 'developing' | 'selling' | 'sold';
  occupancyPct: Pct;                          // 🧮
  noiMarginPct: Pct;                          // 🧮
  vacantCount: Count;                         // 🧮
  unitMap: string;                            // 🧮 chuỗi 1 ký tự/đơn vị: L=đang thuê V=trống S=sắp trống R=sửa chữa (thứ tự theo unitCode)
}
// POST /v1/properties/{id}/duplicate  → nhân bản (không nhân bản con)
```
`fullAddress` với nhà ở có người ở → `400 validation_failed`.

**PropertyRecord – `/v1/property-records`** (Hồ sơ tài sản – chỉ mục)
```ts
interface PropertyRecord extends BaseRecord {
  propertyCode: Code;
  docType: 'title' | 'survey' | 'inspection_report' | 'environmental' | 'insurance' | 'building_permit' | 'contractor_contract' | 'drawings';
  status: 'present' | 'missing' | 'needs_update';
  docDate?: Date;
  storageNote?: string;          // ≤120, mô tả chung, KHÔNG đường dẫn/mật khẩu
}
```
Tài sản mới → server tự tạo danh sách hồ sơ mẫu theo `type`. `GET /v1/property-records/summary` → mỗi tài sản: `{ propertyCode, total, present, missing, needsUpdate, completenessPct, status: 'complete'|'needs_update'|'missing', lastDocDate }` (🧮, app dùng cho màn "Hồ sơ tài sản"). Hồ sơ `needs_update` có thể vào Queue.

**Unit – `/v1/units`** (Đơn vị cho thuê; **không** tên người thuê)
```ts
interface Unit extends BaseRecord {
  propertyCode: Code;
  unitCode: string;              // vd "A-101", duy nhất trong tài sản (đây chính là `code`)
  type: string;                  // "studio" | "1br" | "2br" | "3br" | "commercial" …
  areaSqm: number;
  bedrooms?: number; bathrooms?: number;
  listedRent: Money;             // 🔒 WO
  vacantSince?: Date | null;
  status: 'leased' | 'vacant' | 'vacating' | 'repair' | 'offline';
  vacantDays?: Count;            // 🧮
  activeLeaseCode?: Code | null; // 🧮
}
```

**Lease – `/v1/leases`** (Hợp đồng thuê; **không** tên người thuê)
```ts
interface Lease extends BaseRecord {
  unitCode: string; propertyCode: Code;
  startDate: Date; endDate: Date;                // endDate > startDate
  monthlyRent: Money;                            // 🔒 WO
  deposit: Money;                                // 🔒 WO
  renewalNote?: string;
  renewedFromCode?: Code | null;                 // hợp đồng cũ (khi gia hạn)
  status: 'upcoming' | 'active' | 'expiring' | 'expired' | 'renewed' | 'terminated';
  termMonths: Count;                             // 🧮
  daysRemaining?: number;                        // 🧮
  elapsedPct: Pct;                               // 🧮 tiến độ thời hạn (vòng % trên thẻ)
}
// POST /v1/leases/{id}/renew      body: { startDate, endDate, monthlyRent: Money, deposit?: Money } → tạo hợp đồng mới liên kết `renewedFromCode`, cũ → status=renewed
// POST /v1/leases/{id}/terminate  → status=terminated
```
Tự động: hợp đồng còn ≤ N ngày (cấu hình, mặc định 60) → `status=expiring` + sinh `QueueItem(type=lease_renewal)`; qua `endDate` → `expired`.

**RentCollection – `/v1/rent-collections`** (theo tháng & mã đơn vị)
```ts
interface RentCollection extends BaseRecord {
  month: string;                 // "2026-10"
  propertyCode: Code; unitCode: string;
  amountDue: Money;              // 🔒 WO
  amountCollected: Money;        // 🔒 WO
  lastCollectedAt?: Date | null;
  status: 'paid' | 'partial' | 'unpaid' | 'overdue';   // 🧮 từ due/collected + hạn
  locked: boolean;               // 🧮 kỳ đã chốt
}
```
`GET /v1/rent-collections/summary?month=2026-10` (🧮, app dùng ở danh sách): mỗi tài sản
`{ propertyCode, month, collectedPct, unitsPaid, unitsTotal, overdueCount, lastCollectedAt, status }`.

**LeasingFunnelItem – `/v1/leasing-funnel`** (chỉ số đếm; **không** thông tin người hỏi)
```ts
interface LeasingFunnelItem extends BaseRecord {
  unitCode: string; propertyCode: Code;
  step: 'vacant' | 'preparing' | 'marketing' | 'inquiry' | 'toured' | 'applied' | 'signed';
  stepEnteredAt: Date;
  inquiryCount: Count; tourCount: Count; applicationCount: Count;
  listedRent: Money;             // 🔒 WO
  vacantDays: Count;             // 🧮
}
```
`step` đồng thời là cột Kanban (kéo thả → `PATCH step`). Báo cáo phễu: `GET /v1/reports/funnel?period=` → số đơn vị theo bước, tỷ lệ chuyển đổi giữa các bước (%), thời gian TB mỗi bước (ngày), thời gian trống TB.

### 3.3 Vận hành

**WorkOrder – `/v1/work-orders`** (Bảo trì)
```ts
interface WorkOrder extends BaseRecord {
  propertyCode: Code;
  unitCode?: string | null;      // null = khu vực chung
  category: 'plumbing' | 'electrical' | 'hvac' | 'appliance' | 'roof' | 'landscape' | 'fire_safety' | 'other';
  priority: 'urgent' | 'high' | 'normal';
  title: string;
  description?: string;          // KHÔNG tên/liên hệ người thuê
  vendorCode?: Code | null;
  estimatedCost: Money;          // 🔒 WO
  actualCost: Money;             // 🔒 WO
  dueDate?: Date; completedAt?: Date | null;
  status: 'new' | 'assigned' | 'in_progress' | 'waiting_parts' | 'done' | 'cancelled';
  ageDays: Count;                // 🧮 tuổi lệnh
  processDays?: Count;           // 🧮 khi done
}
```
Lệnh `status=new` chưa giao → tự sinh `QueueItem(type=maintenance)`. `status` là cột Kanban.

**PmSchedule – `/v1/pm-schedules`** (Bảo trì phòng ngừa)
```ts
interface PmSchedule extends BaseRecord {
  propertyCode?: Code | null; area?: 'common' | null;
  task: string;                  // "roof_check" | "hvac_clean" | "drain_clear" | "fire_system_check" | "tree_trim" | "pump_check" | text ngắn
  frequency: 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'seasonal';
  lastDoneAt?: Date | null;
  nextDueAt: Date;               // 🧮
  vendorCode?: Code | null;
  status: 'scheduled' | 'due' | 'in_progress' | 'done' | 'overdue';  // 🧮
}
// POST /v1/pm-schedules/{id}/complete → ghi lastDoneAt=hôm nay, tính nextDueAt mới
// POST /v1/pm-schedules/from-template  body: { templateKey, propertyCode } → sao chép mẫu theo mùa
```
Job server: đến hạn → tự sinh `WorkOrder` + `QueueItem(type=pm_due)`; quá hạn → `overdue`.

**Vendor – `/v1/vendors`** (Nhà thầu – **thông tin công ty**, không tên thợ)
```ts
interface Vendor extends BaseRecord {
  companyName: string;
  serviceType: string;           // "hvac" | "fire_safety" | "roofing" | "landscape" | "plumbing" …
  city?: string;
  licenseNo?: string; licenseExpiry?: Date;
  insuranceExpiry?: Date;
  companyEmail?: string; companyPhone?: string;   // CHUNG của công ty (miễn PII filter)
  rating?: number;               // 0–5, 1 chữ số thập phân
  status: 'valid' | 'expiring' | 'expired';        // 🧮 từ licenseExpiry/insuranceExpiry
}
```

**Equipment – `/v1/equipment`** (Sổ thiết bị & bảo hành)
```ts
interface Equipment extends BaseRecord {
  propertyCode: Code; location?: string;
  kind: 'hvac' | 'water_heater' | 'pump' | 'elevator' | 'generator' | 'kitchen_appliance';
  installedAt: Date;
  brand?: string; model?: string;
  warrantyEnd?: Date;
  expectedLifeYears: number;
  condition: 'good' | 'watch' | 'replace';
  ageYears: number;                    // 🧮
  warrantyRemainingMonths?: number;    // 🧮 (≤0 = hết hạn)
  replaceYear: number;                 // 🧮 năm cần thay dự kiến
  remainingLifePct: Pct;               // 🧮 vòng % trên thẻ
  repairCount: Count;                  // 🧮 từ work-orders liên kết
}
```
Sắp hết bảo hành → `QueueItem(type=warranty_expiring)`.

**Utility – `/v1/utilities`** (Theo dõi tiện ích)
```ts
interface Utility extends BaseRecord {
  propertyCode: Code;
  kind: 'electric' | 'water' | 'gas' | 'trash' | 'internet';
  providerName?: string;         // tên CÔNG TY; KHÔNG số hợp đồng/mã khách hàng
  period: string;                // "2026-10"
  usageValue: number; usageUnit: string;   // "kWh" | "m3" …
  cost: Money;                   // 🔒 WO
  usagePerUnit: number;          // 🧮
  usagePerAreaSqm: number;       // 🧮
  momPct: number;                // 🧮 so kỳ trước (có dấu)
  yoyPct?: number;               // 🧮 so cùng kỳ năm trước
  costVsBudgetPct?: Pct;         // 🧮
  status: 'normal' | 'abnormal_rise';  // 🧮 vượt ngưỡng do EALING đặt
}
```
`abnormal_rise` → có thể tạo `QueueItem` (kiểm tra rò rỉ/thiết bị).

**StormPlan – `/v1/storm-plans`** (Ứng phó bão; mỗi tài sản 1 kế hoạch)
```ts
interface StormPlan extends BaseRecord {
  propertyCode: Code;
  responseLevel: 'normal' | 'preparing' | 'in_storm' | 'inspecting' | 'damaged' | 'recovered';  // = status & cột Kanban
  levelSince: DateTime;
  checklist: { id: string; phase: 'before' | 'during' | 'after'; text: string; done: boolean }[];
  damages: { id: string; category: string; severity: 'minor' | 'moderate' | 'severe'; count: Count }[];  // KHÔNG tiền, KHÔNG người ở
  checklistDonePct: Pct;         // 🧮
  linkedWorkOrderCount: Count;   // 🧮
}
// POST /v1/storm-plans/{id}/damages  → ghi thiệt hại, đồng thời tự tạo WorkOrder liên kết + QueueItem
```

**RenovationProject – `/v1/renovation-projects`** (Dự án cải tạo; xóa kèm mốc tiến độ)
```ts
interface RenovationProject extends BaseRecord {
  name: string;
  propertyCode: Code; unitCode?: string | null;
  scope?: string;
  budget: Money; actualCost: Money;              // 🔒 WO
  vendorCode?: Code | null;
  startDate: Date; expectedEnd: Date;
  progressPct: Pct;
  milestones: { id: string; title: string; dueDate?: Date; done: boolean }[];
  status: 'planned' | 'permitting' | 'in_progress' | 'acceptance' | 'done' | 'paused';
  costVsBudgetPct?: Pct;                         // 🧮
  milestoneDone: Count; milestoneTotal: Count;   // 🧮
}
```

**Inspection – `/v1/inspections`** (Kiểm tra tài sản; không ảnh)
```ts
interface Inspection extends BaseRecord {
  propertyCode: Code;
  date: Date;
  inspectorName?: string;        // tên tự do
  category: 'roof' | 'structure' | 'electrical' | 'plumbing' | 'hvac' | 'fire_safety' | 'elevator' | 'parking' | 'landscape';
  result: 'good' | 'watch' | 'urgent_fix';
  linkedWorkOrderCode?: Code | null;
}
// POST /v1/inspections/{id}/create-work-order  (khi result=urgent_fix)
```

### 3.4 Phát triển & đầu tư

**DevelopmentProject – `/v1/development-projects`** (xóa kèm giai đoạn & việc con)
```ts
type DevStage = 'land_search' | 'land_purchase' | 'zoning' | 'design' | 'permitting' | 'construction' | 'finishing' | 'lease_or_sale';
interface DevelopmentProject extends BaseRecord {
  name: string;
  entityCode: Code;
  area: string;                  // thành phố/khu vực
  productType: 'multifamily' | 'commercial' | 'single_family';
  plannedUnits: Count;
  budget: Money; actualCost: Money;              // 🔒 WO
  stage: DevStage;               // = status & cột Kanban
  stages: { stage: DevStage; plannedDate?: Date; actualDate?: Date | null; progressPct: Pct;
            tasks: { id: string; title: string; done: boolean }[] }[];
  progressPct: Pct;              // 🧮
  delayDays: number;             // 🧮 (âm = sớm)
  costVsBudgetPct?: Pct;         // 🧮
}
// POST /v1/development-projects/{id}/complete → khi stage=lease_or_sale: tạo Property + Units mới
```

**Deal – `/v1/deals`** (Giao dịch đầu tư; Kanban theo `stage`)
```ts
interface Deal extends BaseRecord {
  name: string;
  kind: 'acquisition' | 'disposition';
  area?: string;                 // KHÔNG bắt buộc địa chỉ đầy đủ
  assetType: 'multifamily' | 'single_family' | 'commercial' | 'mixed' | 'land';
  listPrice: Money; offerPrice: Money; projectedNoi: Money;  // 🔒 WO
  projectedCapRatePct?: Pct;     // gửi được (tỷ lệ), hoặc server tính từ NOI/giá
  source?: string;               // "broker" | "direct" | …
  stage: 'screening' | 'analysis' | 'offer' | 'due_diligence' | 'closed' | 'rejected';
  checklist: { key: 'legal_title' | 'building_inspection' | 'environmental' | 'insurance' | 'existing_leases' | 'financials';
               status: 'todo' | 'doing' | 'done'; note?: string }[];
  checklistDone: Count; checklistTotal: Count;   // 🧮
  unitCount?: Count;
}
// POST /v1/deals/{id}/close                 → stage=closed, tạo Property (và Units nếu có)
// POST /v1/deals/{id}/convert-to-development → nếu assetType=land: tạo DevelopmentProject
```
`/v1/deal-checklists` (spec) có thể là sub-resource `PATCH /v1/deals/{id}/checklist/{key}`.

### 3.5 Tài chính

**CashFlow – `/v1/cash-flows`** (bản ghi thu/chi theo pháp nhân)
```ts
interface CashFlow extends BaseRecord {
  entityCode: Code; propertyCode?: Code | null;
  direction: 'income' | 'expense';
  category: 'rent' | 'other_income' | 'sale' | 'interest_income'
          | 'property_tax' | 'insurance' | 'utilities' | 'repairs_maintenance' | 'professional_fees'
          | 'management_fee' | 'loan_interest' | 'other_corporate';
  expenseType?: 'operating' | 'capex';       // chi phí vận hành (vào NOI) hay vốn hóa; lãi vay/khấu hao không vào NOI
  amount: Money;                 // 🔒 WO
  date: Date;
  locked: boolean;               // 🧮
}
```
`GET /v1/cash-flows/summary?month=2026-10` (🧮; danh sách trong app là theo **pháp nhân–tháng**):
```ts
{ entityCode, month, direction: 'positive' | 'negative', changePct, budgetUsedPct, opexChangePct }
```
**Budget – `/v1/budgets`**: `{ entityCode, year, category, amount: Money 🔒 WO }`. So thực tế/ngân sách trả qua summary (%). Dự báo 12 tháng + kịch bản căng thẳng: `/v1/stress-scenarios` (giả định **tỷ lệ**: `incomeDropPct, rateRisePts, vacancyRisePct`) và `GET /v1/reports/cash-forecast` (chỉ %/chỉ số).

**Loan – `/v1/loans`** (Khoản vay)
```ts
interface Loan extends BaseRecord {
  propertyCode?: Code | null; entityCode?: Code | null;   // một trong hai
  lenderName: string;            // tên TỔ CHỨC
  originalPrincipal: Money;      // 🔒 WO
  currentBalance: Money;         // 🔒 WO
  ratePct: Pct;                  // lãi suất, cho phép trả lại
  rateType: 'fixed' | 'floating';
  rateSpread?: string;           // vd "SOFR + 2.8%"
  termYears: number;
  startDate: Date; maturityDate: Date;
  monthlyPayment: Money;         // 🔒 WO
  refinanceNote?: string;
  status: 'current' | 'maturing' | 'paid_off';    // 🧮 maturing = đáo hạn ≤ 12 tháng
  dscr?: number;                 // 🧮
  ltvPct?: Pct;                  // 🧮
  elapsedPct: Pct;               // 🧮
  remainingDays: number;         // 🧮
}
```
KHÔNG có số tài khoản vay, bảo lãnh cá nhân. Đáo hạn chưa có phương án → `QueueItem(type=loan_maturity)`. `GET /v1/reports/debt-ladder` → số khoản đáo hạn theo năm + tổng hợp theo pháp nhân (chỉ đếm/%).

**IncomeEntry – `/v1/income-entries`** (Revenue)
```ts
interface IncomeEntry extends BaseRecord {
  entityCode: Code; propertyCode?: Code | null;
  period: string;                // "2026-10"
  group: 'rent' | 'other' | 'interest';
  amount: Money;                 // 🔒 WO
  source: 'auto' | 'manual';     // auto = tự tạo từ rent-collections/cash-flows
  reason?: string;               // bắt buộc khi source=manual
  locked: boolean;               // 🧮
}
```
**RevenueTarget – `/v1/revenue-targets`**: `{ scope: 'month'|'quarter'|'year', period, target: Money 🔒 WO, completionPct 🧮 }`.
`GET /v1/reports/noi?period=month|quarter|year&month=2026-10` (🧮, danh sách Revenue trong app): mỗi tài sản
```ts
{ propertyCode, period, noiMarginPct, opexRatioPct, incomeChangePct, vacancyLossPct, vsBudget: 'on_target' | 'below' }
```
kèm tỷ trọng nguồn thu `{ rentPct, otherPct, interestPct }`.

**MonthEndClose – `/v1/month-end-closes`** (Đóng sổ; mỗi pháp nhân–tháng 1 bản ghi)
```ts
interface MonthEndClose extends BaseRecord {
  entityCode: Code;
  month: string;                 // "2026-10"
  steps: {
    key: 'rent_entered' | 'expenses_entered' | 'intercompany_reconciled' | 'loan_balance_updated'
       | 'portfolio_value_updated' | 'utilities_checked' | 'budget_reviewed' | string;  // string = bước thêm tạm
    status: 'todo' | 'doing' | 'done';
    doneByName?: string;         // tên tự do
    doneAt?: Date | null;
    note?: string;
  }[];
  status: 'todo' | 'doing' | 'done' | 'locked';  // 🧮; locked chỉ EALING
  completedCount: Count; totalCount: Count; progressPct: Pct;  // 🧮
  reconciliation: 'match' | 'mismatch';          // 🧮 từ intercompany
  dueDate: Date;
}
```
Mẫu bước do EALING cấu hình; tạo bản ghi tháng mới = sao mẫu. Gần hết tháng mà bước chưa xong → `QueueItem(type=closing)`.

### 3.6 Công việc

**QueueItem – `/v1/queue-items`** (Queue; Kanban theo `status`)
```ts
interface QueueItem extends BaseRecord {
  type: 'maintenance' | 'due_diligence' | 'lease_renewal' | 'vacant_unit' | 'loan_maturity'
      | 'closing' | 'storm' | 'warranty_expiring' | 'pm_due' | 'manual';
  source?: { resource: string; id: string; code: string } | null;   // liên kết bản ghi nguồn
  title: string;
  priority: 'urgent' | 'high' | 'normal';
  enqueuedAt: DateTime;
  targetDueAt?: Date;
  assigneeName?: string | null;  // tên tự do (người nhận xử lý)
  status: 'waiting' | 'claimed' | 'in_progress' | 'paused' | 'done';
  waitDays: Count;               // 🧮
  isOverdue: boolean;            // 🧮 quá hạn mục tiêu
  autoGenerated: boolean;        // 🧮
}
// POST /v1/queue-items/{id}/claim    body: { assigneeName }          → status=claimed
// PATCH status/priority/assigneeName/targetDueAt (kéo thả Kanban = PATCH status)
```
- **Tự sinh** khi bản ghi nguồn thỏa điều kiện (bảng ở mục 6) và **tự chuyển `done`** khi nguồn đã xử lý; không tự sinh trùng cho cùng nguồn+loại (idempotent theo `source`+`type`).
- Mục thủ công: `type=manual`, `source=null`.
- `GET /v1/queue-items/stats` → `{ waitingByType: {…}, avgWaitDays, onTimePct, overdueCount, total }`.

**Task – `/v1/tasks`** (Việc cần làm)
```ts
interface Task extends BaseRecord {
  title: string;
  relatedRef?: { resource: string; id: string; code: string } | null;
  dueDate?: Date;
  priority: 'urgent' | 'high' | 'normal';
  status: 'todo' | 'doing' | 'done';
  remindBeforeDays?: number;
  isOverdue: boolean;            // 🧮
}
```
Gợi ý tạo việc tự động (hợp đồng/khoản vay/bảo trì quá hạn/Queue) do **app** bật/tắt cục bộ; server chỉ cần endpoint `GET /v1/tasks/suggestions?types=lease,loan,maintenance,queue`.

### 3.7 Dữ liệu nền

**Partner – `/v1/partners`**
```ts
interface Partner extends BaseRecord {
  companyName: string;
  kind: 'lender' | 'broker' | 'insurer' | 'title_insurer' | 'seller' | 'buyer' | 'investment_partner';
  city?: string; website?: string;
  companyEmail?: string; companyPhone?: string;   // chung của doanh nghiệp
  status: 'active' | 'paused';
  linkedCount: Count;            // 🧮 số khoản vay/cơ hội liên quan
}
```
**ServiceProvider – `/v1/service-providers`**
```ts
interface ServiceProvider extends BaseRecord {
  companyName: string;
  kind: 'accounting' | 'legal' | 'advisor' | 'property_management' | 'bank';
  scope?: string;
  contractStart?: Date; contractEnd?: Date;
  fee: Money;                    // 🔒 WO
  rating?: number;
  status: 'active' | 'expiring' | 'ended';       // 🧮
}
```
KHÔNG có tên cá nhân/liên hệ riêng.

### 3.8 Toolkit – Kịch bản đã lưu

Công cụ tính chạy **trên thiết bị**; server chỉ lưu **kịch bản** chứa **giả định dạng tỷ lệ/chỉ số**, tuyệt đối không lưu số tiền.

**Scenario – `/v1/scenarios`**
```ts
interface Scenario extends BaseRecord {
  toolId: 'acq' | 'loan' | 'refi' | 'dev' | 'lease' | 'exit' | 'stress' | 'reserve';
  name: string;                                   // ≤ 120
  target?: { kind: 'deal' | 'development_project' | 'exit_plan'; code: Code } | null;   // null = không gắn
  ratios: Record<string, number>;                 // CHỈ các khóa cho phép bên dưới
  headline?: { label: string; value: string } | null;   // kết quả chính; chỉ khi KHÔNG phải số tiền (vd "Cap rate" "6.80%")
}
```
Khóa `ratios` cho phép theo công cụ (khóa lạ hoặc giá trị tiền → `400 validation_failed`):
| `toolId` | Khóa được lưu (đơn vị) |
| --- | --- |
| `acq` Phân tích mua | `vac` (%), `opex` (%), `ltv` (%), `rate` (%), `term` (năm) |
| `loan` Tính khoản vay | `rate` (%), `term` (năm) |
| `refi` So sánh tái tài trợ | `r0` (%), `y0` (năm), `r1` (%), `y1` (năm), `fee` (%) |
| `dev` Khả thi dự án | `soft` (%), `cap` (%) |
| `lease` Tốc độ lấp đầy | `units` (số), `vac` (số), `rate` (số/tháng), `target` (%) |
| `exit` Điểm thoái vốn | `cost` (%) |
| `stress` Độ nhạy | `rent` (%), `vac` (%), `cost` (%), `rate` (%) |
| `reserve` Quỹ dự phòng | `roofL`, `hvacL`, `liftL` (năm) |

Quy tắc: `target.code` phải tồn tại ở tài nguyên tương ứng (`deals` / `development-projects` / `exit-plans`); xóa bản ghi đích → server **bỏ liên kết** (`target=null`), **không** xóa kịch bản. App yêu cầu xác nhận hai bước khi xóa kịch bản. Filter: `toolId`, `targetKind`, `targetCode`.

### 3.9 Báo cáo / Dashboard (chỉ đọc, tính ở server)

**`GET /v1/reports/dashboard`** – tham số: `period=month|quarter|year`, `entityCode?`, `propertyCode?`. Trả **toàn bộ chỉ số Home** trong 1 request (mọi số là đếm/%/chỉ số):
```jsonc
{
  "data": {
    "period": "month", "asOf": "2026-11-07T09:41:00Z", "compareTo": "previous_period",
    "structure": { "activeEntities": 4 },
    "realEstate": { "properties": 12, "units": 148, "vacantUnits": 9, "occupancyPct": 94.2, "occupancyDeltaPts": 1.3 },
    "operations": { "noiMarginPct": 62.4, "noiDeltaPts": 0.8, "opexRatioPct": 37.6, "budgetVariancePct": -2.1 },
    "income": { "changePct": 3.2, "mix": { "rentPct": 82, "otherPct": 13, "interestPct": 5 } },
    "cashFlow": { "direction": "positive", "changePct": 4.8 },
    "debt": { "ltvPct": 58, "dscr": 1.42, "maturitiesNext12m": 3, "maturityMonths": [4, 8, 11] },
    "leasingFunnel": { "stages": [ { "step": "vacant", "count": 18 }, { "step": "marketing", "count": 15 }, { "step": "inquiry", "count": 12 }, { "step": "toured", "count": 9 }, { "step": "applied", "count": 7 }, { "step": "signed", "count": 4 } ],
                       "conversionPct": 22.2, "avgVacancyDays": 27 },
    "maintenance": { "openOrders": 17, "avgProcessDays": 3.2, "preventiveOnTimePct": 91 },
    "storm": { "normal": 7, "inspecting": 2, "damaged": 1, "recovered": 2 },
    "equipment": { "underWarranty": 64, "warrantyExpiringSoon": 7, "pastExpectedLife": 3 },
    "utilities": { "usagePerUnitChangePct": 2.4, "abnormalRiseProperties": 1 },
    "closing": { "progressPct": 71, "entitiesReconciled": 3, "entitiesTotal": 4 },
    "development": { "byStage": { "land_purchase": 1, "permitting": 1, "construction": 1, "finishing": 1 }, "avgProgressPct": 41 },
    "exit": { "byStrategy": { "hold": 6, "refinance": 3, "sell": 3 }, "within1y": 1, "within3y": 2, "within5y": 3 },
    "propertyRecords": { "completenessPct": 86 },
    "queue": { "waitingTotal": 23, "waitingByType": { "maintenance": 6, "lease_renewal": 4, "vacant_unit": 5, "closing": 3, "loan_maturity": 1, "other": 4 }, "avgWaitDays": 3.8, "overdueCount": 4 },
    "deals": { "byStage": { "screening": 2, "analysis": 3, "offer": 2, "due_diligence": 1 } },
    "tasks": { "dueCount": 9, "overdueCount": 2 },
    "series": {                                   // 12 điểm gần nhất, cũ → mới
      "occupancyPct": [90.1, 90.8, 91.4, 91.0, 92.2, 92.9, 92.4, 93.1, 93.0, 93.4, 92.9, 94.2],
      "noiMarginPct": [58.1, 59.4, 59.0, 60.2, 61.1, 60.6, 61.8, 61.5, 62.0, 61.6, 62.1, 62.4],
      "maturitiesByYear": [ { "year": 2026, "count": 1 }, { "year": 2027, "count": 3 } ],
      "closingProgressByMonth": [ { "month": "2026-05", "pct": 100 }, { "month": "2026-10", "pct": 71 } ]
    }
  }
}
```
Quy tắc: **không có** số tiền tuyệt đối; thiếu dữ liệu thì trả `null` (app ẩn thẻ), không trả 0 giả.

**`GET /v1/reports/highlights?period=month|quarter|year`** (Điểm nhấn hoạt động – 3 tab):
```jsonc
{ "data": {
  "topProperties":   [ { "propertyCode": "TS-113", "occupancyPct": 100.0, "noiMarginPct": 66.3 } ],          // tối đa N (EALING cấu hình, mặc định 5)
  "watchProperties": [ { "propertyCode": "TS-109", "reason": "vacancy_high" | "utility_rise", "valuePct": 25.0 } ],
  "leasing":   { "newLeases": 4, "renewals": 6, "expirations": 3, "avgVacancyDays": 27, "funnelConversionPct": 22.2 },
  "operations":{ "closedWorkOrders": 15, "preventiveOnTimePct": 91, "equipmentReplaced": 1 },
  "closing":   { "onTimeMonths": 1, "entitiesReconciled": 3 },
  "development":{ "stageChanges": 1, "avgProgressPct": 41, "delayedProjects": 2 },
  "deals":     { "new": 2, "inDiligence": 2, "closed": 1, "rejected": 1 },
  "upcomingMilestones": [ { "date": "2026-11-08", "kind": "warranty", "title": "Hết bảo hành", "code": "TB-0412" } ]   // 5 mốc gần nhất: chỉ loại, mã, ngày
} }
```
Mỗi mục có `code` + `resource` để app mở bản ghi liên quan khi bấm.

**`GET /v1/timeline?from=2026-11-01&to=2026-11-30&kinds=lease,loan&entityCode=&propertyCode=`** – gộp sự kiện:
```ts
{ date: Date; kind: 'lease' | 'loan' | 'maintenance' | 'warranty' | 'project' | 'closing' | 'queue' | 'storm' | 'task';
  title: string; code: Code; resource: string; id: string }
```
Nguồn: hạn kết thúc hợp đồng, đáo hạn khoản vay, `dueDate` lệnh bảo trì, `nextDueAt` bảo trì phòng ngừa, `warrantyEnd`, mốc dự án cải tạo/phát triển, bước đóng sổ, `targetDueAt` Queue, `dueDate` việc cần làm, mốc mùa bão. Cho phép `from..to` tối đa 92 ngày.

**Các báo cáo khác** (đều chỉ chỉ-số): `/v1/reports/{noi, occupancy, funnel, utilities, equipment, closing, debt-ladder, portfolio-allocation}`. Màn "Báo cáo & phân tích" liệt kê 4 mẫu (phân bổ danh mục, bất động sản, nợ đáo hạn, vận hành & bão): `GET /v1/reports/catalog` → `[ { code: "BC-01", title, description, readinessPct, status: 'ready'|'updating', formats: ['pdf','csv'] } ]`.

**Xuất:** `GET /v1/reports/export?type=<report>&format=csv|pdf&…` – chỉ gồm chỉ số/tỷ lệ/số đếm (**không số tiền**); PDF có dòng "Không phải báo cáo tài chính chính thức, không phải chào mời đầu tư và không bảo đảm kết quả tương lai". Giới hạn số lần xuất/ngày/IP (`429`).

### 3.10 Nội dung công khai (EALING quản lý, app chỉ đọc)

**`GET /v1/public/company`** (cache được, `ETag`/`Cache-Control: max-age=3600`)
```jsonc
{ "data": {
  "name": "EALING, LLC",
  "address": "5785 SW 118th St, Coral Gables, FL 33156-5748, United States",
  "phone": "+1 662 856 9899", "email": "…", "website": null, "hours": null,
  "field": "Quản lý và đầu tư tài sản, bất động sản (Holding & Real Estate)",
  "foundedYear": 2016, "yearsActive": 10,
  "headcount": { "total": 38, "updatedAt": "2026-11-01", "byDepartment": [ { "name": "Quản lý BĐS", "count": 14 }, { "name": "Phát triển", "count": 9 }, { "name": "Tài chính & kế toán", "count": 8 }, { "name": "Vận hành", "count": 7 } ] },
  "scale": { "propertyCount": 12, "unitCount": 148, "occupancyPct": 94.2, "period": "2026-Q3", "updatedAt": "2026-10-15" },   // null/ẩn nếu chưa được EALING duyệt công bố
  "operatingAreas": ["Miami-Dade, Florida"],
  "licenses": [ { "name": "…", "number": "…" } ],
  "values": [ { "title": "Minh bạch", "text": "…" } ],
  "process": [ { "title": "Phân tích", "text": "…" } ],
  "history": [ { "year": 2016, "text": "Thành lập EALING, LLC tại Florida" } ],
  "leadership": [ { "fullName": "…", "title": "…", "area": "…", "photoUrl": null } ],   // CHỈ người đã đồng ý công khai
  "equalHousingBadge": true, "updatedAt": "2026-11-01T00:00:00Z"
} }
```
Các chỉ số trong `scale` chỉ có khi **thật + được duyệt**; tuyệt đối không lấy tự động từ dữ liệu dùng chung. Không có tổng giá trị tài sản nếu chưa được đồng ý rõ ràng.

**`GET /v1/public/templates`** → `[ { key, title, version, updatedAt, downloadUrl } ]` (8 mẫu: checklist thẩm định, mẫu đóng sổ, lịch bảo trì theo mùa, kế hoạch ứng phó bão, bàn giao đơn vị, danh sách hồ sơ, ngân sách năm/dự báo, thuật ngữ).

---

## 4. Bảng enum ↔ nhãn tiếng Việt (nguồn cho `GET /v1/meta`)

| Enum | Giá trị → nhãn |
| --- | --- |
| Entity.status | `active` Đang hoạt động · `suspended` Tạm ngừng · `dissolved` Đã giải thể |
| Entity.type | `llc` LLC · `inc` Inc. · `other` Khác |
| Entity.purpose | `hold_real_estate` Nắm giữ BĐS · `invest` Đầu tư · `operate` Vận hành · `develop` Phát triển |
| AssetClass.classKey | `rental_real_estate` BĐS cho thuê · `land` Đất · `developing_real_estate` BĐS đang phát triển · `other_investment` Đầu tư khác · `cash_equivalent` Tiền mặt tương đương |
| AssetClass.status | `within` Trong khoảng · `slight` Lệch nhẹ · `high` Lệch nhiều |
| IntercompanyEntry.txnType | `capital_transfer` Chuyển vốn · `expense_paid_on_behalf` Trả chi phí hộ · `shared_cost_allocation` Phân bổ chi phí chung · `repayment` Hoàn trả |
| IntercompanyPair.reconcileStatus | `match` Khớp · `mismatch` Lệch |
| ExitPlan.strategy | `hold` Giữ · `refinance` Tái tài trợ · `sell` Bán · `renovate_then_sell` Cải tạo rồi bán |
| ExitPlan.lifecycleStage | `new` Mới mua · `stabilized` Ổn định · `value_add` Tăng giá trị · `prep_sale` Chuẩn bị bán · `sold` Đã bán |
| Property.type | `multifamily` Nhà ở nhiều căn · `single_family` Nhà đơn lập · `commercial` Thương mại · `mixed` Hỗn hợp · `land` Đất |
| Property.status | `owned` Đang sở hữu · `managed` Đang quản lý · `developing` Đang phát triển · `selling` Đang bán · `sold` Đã bán |
| PropertyRecord.docType | `title` Quyền sở hữu · `survey` Bản đồ đo đạc · `inspection_report` Báo cáo kiểm tra · `environmental` Môi trường · `insurance` Bảo hiểm · `building_permit` Giấy phép xây dựng · `contractor_contract` Hợp đồng nhà thầu · `drawings` Bản vẽ |
| PropertyRecord.status | `present` Có · `missing` Thiếu · `needs_update` Cần cập nhật |
| Unit.status | `leased` Đang thuê · `vacant` Trống · `vacating` Sắp trống · `repair` Đang sửa chữa · `offline` Ngừng cho thuê |
| Lease.status | `upcoming` Sắp bắt đầu · `active` Đang hiệu lực · `expiring` Sắp hết hạn · `expired` Hết hạn · `renewed` Gia hạn · `terminated` Chấm dứt |
| RentCollection.status | `paid` Đã thu đủ · `partial` Thu một phần · `unpaid` Chưa thu · `overdue` Quá hạn |
| Funnel.step | `vacant` Trống · `preparing` Đang chuẩn bị · `marketing` Đang quảng bá · `inquiry` Có người hỏi · `toured` Đã cho xem · `applied` Đã nhận hồ sơ · `signed` Đã ký |
| WorkOrder.category | `plumbing` Nước · `electrical` Điện · `hvac` Điều hòa · `appliance` Thiết bị · `roof` Mái · `landscape` Cảnh quan · `fire_safety` An toàn cháy · `other` Khác |
| WorkOrder.status | `new` Mới · `assigned` Đã giao · `in_progress` Đang xử lý · `waiting_parts` Chờ vật tư · `done` Hoàn tất · `cancelled` Hủy |
| priority (chung) | `urgent` Khẩn cấp · `high` Cao · `normal` Thường |
| PmSchedule.frequency | `monthly` Hằng tháng · `quarterly` Quý · `semiannual` 6 tháng · `annual` Năm · `seasonal` Theo mùa |
| PmSchedule.status | `scheduled` Đã lên lịch · `due` Đến hạn · `in_progress` Đang làm · `done` Hoàn tất · `overdue` Quá hạn |
| Vendor.status | `valid` Còn hạn · `expiring` Sắp hết hạn · `expired` Hết hạn |
| Equipment.kind | `hvac` Điều hòa · `water_heater` Máy nước nóng · `pump` Bơm · `elevator` Thang máy · `generator` Máy phát điện · `kitchen_appliance` Thiết bị bếp |
| Equipment.condition | `good` Tốt · `watch` Cần theo dõi · `replace` Cần thay |
| Utility.kind | `electric` Điện · `water` Nước · `gas` Gas · `trash` Rác · `internet` Internet |
| Utility.status | `normal` Bình thường · `abnormal_rise` Tăng bất thường |
| StormPlan.responseLevel | `normal` Bình thường · `preparing` Chuẩn bị · `in_storm` Trong bão · `inspecting` Đang kiểm tra · `damaged` Có thiệt hại · `recovered` Đã khắc phục |
| Damage.severity | `minor` Nhẹ · `moderate` Vừa · `severe` Nặng |
| RenovationProject.status | `planned` Dự kiến · `permitting` Xin phép · `in_progress` Đang thi công · `acceptance` Nghiệm thu · `done` Hoàn thành · `paused` Tạm dừng |
| Inspection.result | `good` Tốt · `watch` Cần theo dõi · `urgent_fix` Cần sửa gấp |
| DevStage | `land_search` Tìm đất · `land_purchase` Mua đất · `zoning` Quy hoạch và thủ tục · `design` Thiết kế · `permitting` Xin phép · `construction` Thi công · `finishing` Hoàn thiện · `lease_or_sale` Cho thuê hoặc bán |
| Deal.stage | `screening` Sàng lọc · `analysis` Phân tích · `offer` Chào mua · `due_diligence` Thẩm định · `closed` Đóng giao dịch · `rejected` Từ chối |
| Loan.status | `current` Đang trả · `maturing` Sắp đáo hạn · `paid_off` Đã tất toán |
| MonthEndClose.status | `todo` Chưa làm · `doing` Đang làm · `done` Xong · `locked` Đã chốt kỳ |
| QueueItem.type | `maintenance` Bảo trì · `due_diligence` Thẩm định · `lease_renewal` Gia hạn hợp đồng · `vacant_unit` Đơn vị trống · `loan_maturity` Khoản vay sắp đáo hạn · `closing` Đóng sổ · `storm` Ứng phó bão · `warranty_expiring` Bảo hành sắp hết · `pm_due` Bảo trì phòng ngừa đến lịch · `manual` Thủ công |
| QueueItem.status | `waiting` Chờ · `claimed` Đã nhận · `in_progress` Đang xử lý · `paused` Tạm dừng · `done` Xong |
| Task.status | `todo` Chưa làm · `doing` Đang làm · `done` Xong |
| Partner.kind | `lender` Bên cho vay · `broker` Môi giới · `insurer` Công ty bảo hiểm · `title_insurer` Bảo hiểm quyền sở hữu · `seller` Bên bán · `buyer` Bên mua · `investment_partner` Đối tác đầu tư |
| ServiceProvider.kind | `accounting` Kế toán · `legal` Luật sư · `advisor` Cố vấn · `property_management` Quản lý tài sản · `bank` Ngân hàng |
| CashFlow.category | thu: `rent` Tiền thuê · `other_income` Thu khác · `sale` Bán tài sản · `interest_income` Lãi; chi: `property_tax` Thuế BĐS · `insurance` Bảo hiểm · `utilities` Tiện ích · `repairs_maintenance` Sửa chữa & bảo trì · `professional_fees` Phí chuyên gia · `management_fee` Phí quản lý · `loan_interest` Lãi vay · `other_corporate` Chi phí doanh nghiệp khác |

---

## 5. Xóa hẳn & cascade

Mọi `DELETE` xóa vật lý. App đã có hộp thoại xác nhận hai bước nên BE **không** cần cơ chế xác nhận. BE nên có `GET /v1/<resource>/{id}/delete-impact` → `{ "willDelete": { "units": 24, "leases": 20, "workOrders": 6 } }` để app liệt kê hậu quả trong hộp thoại.

| Xóa | Xóa kèm |
| --- | --- |
| Property | Units, Leases, RentCollections, LeasingFunnel items, WorkOrders, PmSchedules, Equipment, Utilities, PropertyRecords, StormPlan, Inspections, RenovationProjects, ExitPlan, Loans gắn tài sản |
| Unit | Leases, RentCollections, LeasingFunnel item của đơn vị |
| RenovationProject | Mốc tiến độ |
| DevelopmentProject | Giai đoạn và việc con |
| Deal | Checklist thẩm định |
| Entity | **Chặn** (`409 has_dependents`) nếu còn tài sản/dự án/khoản vay/giao dịch nội bộ, hoặc cascade theo quyết định BE – cần thống nhất |
| Bất kỳ bản ghi nguồn | `QueueItem` tự sinh từ bản ghi đó bị xóa theo; mục thủ công thì giữ |
| Bản ghi đích của Scenario | Chỉ bỏ liên kết `target`, **giữ** Scenario |

---

## 6. Job nền & quy tắc tự sinh (BE chịu trách nhiệm)

| Điều kiện nguồn | Hành động |
| --- | --- |
| Lease còn ≤ N ngày hết hạn (mặc định 60) | `status=expiring`; sinh `QueueItem(lease_renewal)`. Quá hạn → `expired`, item → `done` khi đã `renewed`/`terminated` |
| Unit trống (`vacant`) | Sinh `QueueItem(vacant_unit)` (ưu tiên theo số ngày trống) |
| Loan còn ≤ 12 tháng đáo hạn, `refinanceNote` trống | `status=maturing`; sinh `QueueItem(loan_maturity)` |
| WorkOrder `new` chưa giao | Sinh `QueueItem(maintenance)`; xong khi `status` ≥ `assigned` |
| PmSchedule đến hạn | Sinh `WorkOrder` + `QueueItem(pm_due)`; khi hoàn tất → tính `nextDueAt` |
| Equipment sắp hết bảo hành (≤ 60 ngày) | Sinh `QueueItem(warranty_expiring)` |
| Utility `abnormal_rise` | Có thể sinh `QueueItem` kiểm tra |
| PropertyRecord `needs_update` | Có thể sinh `QueueItem` |
| MonthEndClose còn bước chưa xong gần hết tháng; IntercompanyPair `mismatch` khi đóng sổ | Sinh `QueueItem(closing)` |
| Deal chờ phân tích/thẩm định | Sinh `QueueItem(due_diligence)` |
| StormPlan có damage | Tạo `WorkOrder` liên kết + `QueueItem(storm)`; tài sản chuyển `inspecting`/`damaged` cũng sinh item |
| Lease/Loan/Equipment/… thay đổi | Cập nhật các trường 🧮 (occupancy, DSCR, LTV, `unitMap`…) – tính khi đọc hoặc cache có TTL ngắn |

Các ngưỡng (ngày cảnh báo, số mục hiển thị Top N, ngưỡng `abnormal_rise`) do **EALING cấu hình ở trang quản trị**, BE đọc từ cấu hình – không hard-code.

---

## 7. Ngoài phạm vi API của app (không làm trong v1)

- Đăng nhập/tài khoản/phân quyền; thanh toán, chuyển tiền, kết nối ngân hàng; tải tệp lên.
- Trang quản trị web của EALING (kiểm duyệt, chốt kỳ, cập nhật nội dung công khai, cấu hình ngưỡng/mẫu) – dùng API riêng có xác thực.
- `content-reports` và cài đặt "tên hiển thị" – đã bỏ khỏi giao diện (xem mục 1).

---

## 8. Câu hỏi cần BE/PO chốt

1. `Entity` có chặn xóa khi còn bản ghi con hay cascade? (đề xuất: chặn, vì xóa pháp nhân kéo theo quá nhiều dữ liệu).
2. Số liệu 🧮 tính khi đọc hay tính sẵn bằng job (đề xuất: dashboard/highlights/summary cache 60 giây; các trường 🧮 trong bản ghi tính khi đọc).
3. Phân trang `cursor` hay `page/limit`? (tài liệu này dùng `cursor`).
4. Vì không có header/token/chứng thực: BE xác nhận chấp nhận rủi ro phá hoại/spam chỉ được chặn bằng rate limit theo IP + WAF + kiểm tra PII; có cần thêm cơ chế nào khác ở tầng hạ tầng không (ví dụ chặn theo quốc gia, CAPTCHA ở trang quản trị).
5. Giới hạn cụ thể: số bản ghi/ngày/IP, số lần xuất/ngày, số lần sửa/xóa trong khoảng thời gian.
6. Mức ưu tiên/ngưỡng mặc định của các job ở mục 6 (N ngày hết hạn hợp đồng, ngưỡng bảo hành…).
7. Có cần `GET /v1/<resource>/stats` cho mọi tài nguyên hay chỉ cho các màn có thanh tóm tắt (đề xuất: tất cả tài nguyên có `status`, rẻ và dùng chung).
