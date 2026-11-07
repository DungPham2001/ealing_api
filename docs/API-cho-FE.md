# Ealing Holdings API — tài liệu cho Frontend

Base URL: `https://ealing-api.vercel.app` — mọi endpoint nằm dưới `/v1` (vd `https://ealing-api.vercel.app/v1/properties`). Kiểm tra sống: `GET https://ealing-api.vercel.app/health`.
Không có đăng nhập/token. Dữ liệu trả về luôn là JSON (trừ export và 204).

## 1. Quy ước chung

### 1.1 Định dạng bản ghi
Mọi bản ghi trả về có: `id` (UUID), `code` (mã nghiệp vụ do server sinh, vd `TS-101`, pháp nhân `PN-A`), `version` (số nguyên, bắt đầu từ 1), các trường nghiệp vụ, trường tính sẵn, `status` (bản sao của trường trạng thái chính), `note`, `ownerName`, `createdByName`, `createdAt`, `updatedAt`.
- `note` (≤500), `ownerName` (≤40), `createdByName` (≤40) là trường tùy chọn, có ở mọi resource.
- **Liên kết giữa các bản ghi dùng `code`, không dùng `id`** (vd `propertyCode: "TS-101"`). `unitCode` chỉ duy nhất trong một `propertyCode`.
- Ngày: `YYYY-MM-DD`. Tháng: `YYYY-MM`. Thời điểm (`createdAt`...): ISO 8601.
- Trường `null` nghĩa là chưa có giá trị.

### 1.2 Tiền — chỉ ghi, không bao giờ trả về
Mọi trường tiền (kiểu `money`) **chỉ gửi lên, server không trả lại** trong JSON, CSV hay PDF. Định dạng gửi:
```json
{ "amountMinor": 125000, "currency": "USD" }
```
`amountMinor` là số nguyên đơn vị nhỏ nhất (cent), ≥ 0; `currency` mã ISO 3 chữ hoa, mặc định `USD`. FE hiển thị các chỉ số đã tính sẵn (tỷ lệ %, DSCR, số ngày...) thay vì số tiền.

### 1.3 Envelope
- Một bản ghi / kết quả: `{ "data": …, "asOf": "<ISO>" }`
- Danh sách: `{ "data": [...], "page": { "limit", "nextCursor", "total" }, "asOf" }`
- `GET …/stats`: `{ "total": n, "byStatus": { "<status>": n }, "asOf" }`
- Báo cáo (`/reports/*`) trả `{ "data": …, "asOf" }`.
- `DELETE` thành công: `204`, không có body.
- Tạo mới: `201`.

### 1.4 CRUD chuẩn (áp dụng cho mọi resource ở mục 3)
| Method | Đường dẫn | Mô tả |
|---|---|---|
| GET | `/v1/{resource}` | Danh sách, có lọc/sắp xếp/phân trang |
| GET | `/v1/{resource}/stats` | Đếm theo trạng thái (cùng bộ lọc, trừ `status`). Chỉ resource có trường trạng thái |
| POST | `/v1/{resource}` | Tạo mới. Không gửi `id`, `code`, `version` |
| GET | `/v1/{resource}/{id}` | Chi tiết (theo `id`) |
| PATCH | `/v1/{resource}/{id}` | Sửa một phần. **Bắt buộc gửi `version`** hiện tại |
| DELETE | `/v1/{resource}/{id}` | Xóa (có thể kéo theo dữ liệu liên quan, xem 1.7) |
| GET | `/v1/{resource}/{id}/delete-impact` | Xem trước tác động trước khi xóa |

### 1.5 Danh sách: lọc, tìm, sắp xếp, phân trang
`GET /v1/{resource}?limit=&cursor=&q=&status=&sort=&<field>=a,b`
- `limit`: 1–100, mặc định 20. `cursor`: lấy từ `page.nextCursor` của trang trước (`null` = hết).
- `q`: tìm không phân biệt hoa thường và dấu tiếng Việt (theo mã, tên, mô tả, trạng thái).
- `status`: một hoặc nhiều giá trị, cách nhau dấu phẩy (`status=new,assigned`).
- `sort`: mặc định `-updatedAt`; có thể `code`, `createdAt`, `version` hoặc trường bất kỳ không phải tiền/object/mảng; thêm tiền tố `-` để giảm dần.
- Lọc bằng giá trị bằng nhau trên bất kỳ trường lưu trữ nào (trừ tiền), vd `?propertyCode=TS-101&month=2026-10`; nhiều giá trị cách nhau dấu phẩy. `null` lọc theo giá trị rỗng. Tham số không biết sẽ bị bỏ qua.

### 1.6 Sửa đồng thời (optimistic lock)
`PATCH` gửi kèm `version` đang giữ:
```json
PATCH /v1/properties/<id>
{ "version": 3, "city": "Miami" }
```
Nếu bản ghi đã bị người khác sửa → `409 version_conflict`, trong `error.current` có bản ghi mới nhất để FE hiển thị/gộp. Mỗi lần sửa thành công `version` tăng 1 và response trả bản ghi mới.

### 1.7 Xóa
Gọi `GET …/{id}/delete-impact` để hiện hộp xác nhận (liệt kê số bản ghi sẽ bị xóa/gỡ liên kết). Nếu còn dữ liệu phụ thuộc không được phép xóa → `409 has_dependents`.

### 1.8 Trạng thái tự động
Một số trạng thái do server tính (lease, rent-collections, loans, vendors, pm-schedules, utilities, service-providers, asset-classes, month-end-closes) — đánh dấu **chỉ đọc**, FE không gửi lên. Server làm mới hằng ngày.

### 1.9 Khóa kỳ
Kỳ đã chốt (do EALING cấu hình phía server): ghi/sửa/xóa dữ liệu thuộc kỳ đó trả `409 period_locked`. Các bản ghi có trường `locked` cho biết đã khóa chưa — FE nên disable nút sửa.

### 1.10 Lỗi
```json
{ "error": { "code": "validation_failed", "message": "…", "fields": [{ "field": "zip", "code": "required" }], "requestId": "…" } }
```
| HTTP | `code` | Ý nghĩa |
|---|---|---|
| 400 | `validation_failed` | Sai dữ liệu; chi tiết ở `error.fields[]` (`field`, `code`; `field` có thể dạng `checklist[0].text`) |
| 404 | `not_found` | Không có bản ghi / endpoint |
| 409 | `version_conflict` | `version` cũ; xem `error.current` |
| 409 | `duplicate` | Trùng bản ghi duy nhất |
| 409 | `has_dependents` | Còn dữ liệu phụ thuộc, không xóa được |
| 409 | `invalid_state` | Hành động không hợp lệ ở trạng thái hiện tại |
| 409 | `period_locked` | Kỳ đã chốt |
| 413 | `payload_too_large` | Body > 1MB |
| 422 | `pii_detected` | Phát hiện dữ liệu cá nhân (email, SĐT, số thẻ, SSN, số tài khoản, mã số thuế) trong trường văn bản. `error.fields[].kind` cho biết loại. Riêng `companyEmail`/`companyPhone` được phép |
| 429 | `rate_limited` | Quá giới hạn; đọc header `Retry-After` (giây) |
| 500 | `internal_error` | Lỗi hệ thống; gửi kèm `requestId` khi báo lỗi |

Mã `fields[].code` thường gặp: `required`, `invalid_type`, `out_of_range`, `invalid_enum`, `invalid_date`, `invalid_month`, `invalid_currency`, `not_found` (mã tham chiếu không tồn tại), `cycle`.

### 1.11 Giới hạn tần suất (theo IP)
Mặc định: đọc 60/phút, ghi 20/phút, tạo mới 300/ngày, export 30/ngày. Vi phạm nhiều lần sẽ bị chặn tạm vài phút. Giá trị thực tế xem ở `GET /v1/meta` → `limits.rate`.

### 1.12 Dữ liệu tham chiếu
`GET /v1/meta` trả `enums` (mọi enum kèm nhãn tiếng Việt, dùng để dựng dropdown/badge), `limits` (độ dài tối đa, ngưỡng cảnh báo, giới hạn phân trang).

## 2. Endpoint ngoài CRUD

### 2.1 Báo cáo & dashboard (GET, mọi báo cáo nhận `entityCode`, `propertyCode` để lọc khi phù hợp)
| Đường dẫn | Tham số thêm | Nội dung |
|---|---|---|
| `/v1/reports/dashboard` | `period`, `month` | Tổng quan danh mục |
| `/v1/reports/highlights` | | Điểm nổi bật + 5 sự kiện sắp tới |
| `/v1/reports/noi` | | NOI / biên NOI |
| `/v1/reports/occupancy` | | Tỷ lệ lấp đầy |
| `/v1/reports/funnel` | | Phễu cho thuê |
| `/v1/reports/utilities` | `period` (`YYYY-MM`) | Điện nước theo kỳ |
| `/v1/reports/equipment` | | Thiết bị theo loại/tình trạng/bảo hành |
| `/v1/reports/closing` | `month` | Tiến độ chốt sổ cuối tháng |
| `/v1/reports/debt-ladder` | | Lịch đáo hạn nợ |
| `/v1/reports/portfolio-allocation` | | Cơ cấu danh mục vs mục tiêu |
| `/v1/reports/cash-forecast` | `scenarioId` (id hoặc code của `stress-scenarios`) | Dự báo dòng tiền, tùy chọn áp kịch bản stress |
| `/v1/reports/catalog` | | Danh mục báo cáo có thể xuất |
| `/v1/reports/export` | `type=<tên báo cáo>`, `format=csv\|pdf` | Tải file (header `Content-Disposition: attachment`). Chỉ chỉ số/tỷ lệ/số đếm, không có số tiền. PDF bỏ dấu tiếng Việt, CSV giữ dấu |

Báo cáo trả chỉ số và tỷ lệ, **không trả số tiền**.

### 2.2 Timeline
`GET /v1/timeline?from=YYYY-MM-DD&to=YYYY-MM-DD&kinds=a,b&entityCode=&propertyCode=` — các sự kiện theo ngày (hợp đồng hết hạn, khoản vay đáo hạn, bảo trì…). Mặc định cả tháng hiện tại; khoảng tối đa 92 ngày (`range_too_long`).

### 2.3 Nội dung công khai (có `ETag`, cache 1 giờ; gửi `If-None-Match` để nhận 304)
- `GET /v1/public/company` — thông tin công ty.
- `GET /v1/public/templates` — mẫu biểu tải về (`downloadUrl` có thể `null` đến khi EALING nhập link).

### 2.4 Chế độ xem dẫn xuất
| Đường dẫn | Mô tả |
|---|---|
| `GET /v1/entities/tree` | Cây pháp nhân: `[{ code, type, ownershipPct, children: [...] }]` |
| `GET /v1/intercompany-pairs` | Các cặp giao dịch nội bộ và trạng thái khớp (`month`, `entityCode` để lọc) |
| `GET /v1/property-records/summary` | Tóm tắt hồ sơ tài sản |
| `GET /v1/rent-collections/summary` | Tóm tắt thu tiền thuê |
| `GET /v1/cash-flows/summary` | Tóm tắt dòng tiền |
| `GET /v1/queue-items/stats` | Raw (không bọc `data`): `waitingByType`, `avgWaitDays`, `onTimePct`, `overdueCount`, `total`, `asOf` |
| `GET /v1/tasks/suggestions?types=lease,loan,maintenance,queue` | Gợi ý công việc từ dữ liệu (chưa có task tương ứng) |

### 2.5 Hành động (POST, body JSON; trả bản ghi mới nhất)
| Đường dẫn | Body | Kết quả / điều kiện |
|---|---|---|
| `POST /v1/intercompany-entries/{id}/confirm` | `{ amount: money }` | Bên đối ứng nhập số tiền, cả hai bút toán thành "đã xác nhận" |
| `POST /v1/exit-plans/{id}/create-sale-deal` | `{}` | Tạo deal bán; chỉ khi `lifecycleStage=prep_sale` |
| `POST /v1/properties/{id}/duplicate` | `{}` | Nhân bản tài sản (tên + " (bản sao)") |
| `POST /v1/leases/{id}/renew` | `{ startDate, endDate, monthlyRent, deposit? }` | Tạo hợp đồng mới, hợp đồng cũ → `renewed` |
| `POST /v1/leases/{id}/terminate` | `{}` | Hợp đồng → `terminated` |
| `POST /v1/pm-schedules/{id}/complete` | `{}` | Đánh dấu hoàn thành, tính lần tới, đóng work-order liên quan |
| `POST /v1/pm-schedules/from-template` | `{ templateKey, propertyCode }` | `templateKey`: `hurricane_prep`, `hvac_service`, `fire_safety`, `monthly_basics` |
| `POST /v1/storm-plans/{id}/damages` | `{ category, severity, count }` | Ghi thiệt hại, kế hoạch → `damaged`, tạo work-order. Trả `{ stormPlan, workOrder }` |
| `POST /v1/inspections/{id}/create-work-order` | `{}` | Chỉ khi `result=urgent_fix` và chưa liên kết. Trả `{ inspection, workOrder }` |
| `POST /v1/development-projects/{id}/complete` | `{}` | Hoàn thành dự án, tạo tài sản. Trả `{ project, property }` |
| `POST /v1/deals/{id}/close` | mua (`acquisition`): `{ entityCode, city?, zip? }`; bán: `{ propertyCode? }` | Đóng deal; mua sẽ tạo tài sản + units. Trả `{ deal, property }` |
| `POST /v1/deals/{id}/convert-to-development` | `{ entityCode, productType?, plannedUnits? }` | Chỉ deal có `assetType=land` |
| `PATCH /v1/deals/{id}/checklist/{key}` | `{ version, status?, note? }` | `key`: `legal_title` `building_inspection` `environmental` `insurance` `existing_leases` `financials` |
| `POST /v1/queue-items/{id}/claim` | `{ assigneeName }` | Nhận việc, trạng thái → `claimed` |

## 3. Resource
Mỗi resource có đủ bộ endpoint ở mục 1.4. Bảng dưới liệt kê trường **gửi lên**; ngoài ra mọi bản ghi trả về còn các trường chung ở 1.1 và trường tính sẵn (chỉ đọc). Đơn vị: `%` là số 0–100.
Nhóm: Cấu trúc (entities, asset-classes, intercompany-entries, exit-plans) · Bất động sản (properties, property-records, units, leases, rent-collections, leasing-funnel) · Vận hành (work-orders, pm-schedules, vendors, equipment, utilities, storm-plans, renovation-projects, inspections) · Phát triển (development-projects, deals) · Tài chính (cash-flows, budgets, stress-scenarios, loans, income-entries, revenue-targets, month-end-closes) · Công việc (queue-items, tasks) · Danh mục (partners, service-providers, scenarios).

### `/v1/entities` — mã `PN-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `type` | enum: `llc` `inc` `other` | bắt buộc |
| `state` | string (≤2) | bắt buộc |
| `purpose` | enum: `hold_real_estate` `invest` `operate` `develop` | bắt buộc |
| `formedAt` | date `YYYY-MM-DD` | bắt buộc |
| `status` | enum: `active` `suspended` `dissolved` | bắt buộc; mặc định `active` |
| `parentCode` | mã `code` của `entities` |  |
| `parentOwnershipPct` | number (0–100) |  |

Trường tính sẵn (chỉ đọc): `propertyCount`, `projectCount`

### `/v1/asset-classes` — mã `DM-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `classKey` | enum: `rental_real_estate` `land` `developing_real_estate` `other_investment` `cash_equivalent` | bắt buộc |
| `entityCode` | mã `code` của `entities` |  |
| `estimatedValue` | money | bắt buộc; chỉ ghi, không trả về |
| `valueUpdatedAt` | date `YYYY-MM-DD` |  |
| `targetWeightPct` | number (0–100) | bắt buộc |
| `toleranceBandPct` | number (0–100) | mặc định `0` |
| `status` | enum: `within` `slight` `high` | chỉ đọc; mặc định `within` |

Trường tính sẵn (chỉ đọc): `actualWeightPct`, `deviationPts`, `liquidityMonths`

### `/v1/intercompany-entries` — mã `NB-…`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `creditEntityCode` | mã `code` của `entities` | bắt buộc |
| `debitEntityCode` | mã `code` của `entities` | bắt buộc |
| `txnType` | enum: `capital_transfer` `expense_paid_on_behalf` `shared_cost_allocation` `repayment` | bắt buộc |
| `date` | date `YYYY-MM-DD` | bắt buộc |
| `amount` | money | bắt buộc; chỉ ghi, không trả về |
| `description` | string (≤80) |  |
| `counterpartConfirmed` | boolean | chỉ đọc |
| `isCounterpart` | boolean | chỉ đọc |

### `/v1/exit-plans` — mã `TV-…` · trường trạng thái: `lifecycleStage`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `propertyCode` | mã `code` của `properties` | bắt buộc |
| `strategy` | enum: `hold` `refinance` `sell` `renovate_then_sell` | bắt buộc |
| `holdYears` | number | bắt buộc |
| `targetExitYear` | int | bắt buộc |
| `trigger` | object |  |
| ↳ `metric` | enum: `cap_rate` `ltv` | bắt buộc |
| ↳ `op` | enum: `gte` `lte` | bắt buộc |
| ↳ `valuePct` | number (0–100) | bắt buộc |
| `priority` | int | bắt buộc |
| `lifecycleStage` | enum: `new` `stabilized` `value_add` `prep_sale` `sold` | bắt buộc; mặc định `new` |

Trường tính sẵn (chỉ đọc): `triggerMet`

### `/v1/properties` — mã `TS-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `name` | string (≤120) | bắt buộc |
| `type` | enum: `multifamily` `single_family` `commercial` `mixed` `land` | bắt buộc |
| `entityCode` | mã `code` của `entities` | bắt buộc |
| `city` | string (≤60) | bắt buộc |
| `zip` | string (≤10) | bắt buộc |
| `fullAddress` | string (≤160) |  |
| `yearBuilt` | int |  |
| `areaSqm` | number |  |
| `unitCount` | int | bắt buộc |
| `purchasePrice` | money | chỉ ghi, không trả về |
| `purchaseDate` | date `YYYY-MM-DD` |  |
| `estimatedValue` | money | chỉ ghi, không trả về |
| `status` | enum: `owned` `managed` `developing` `selling` `sold` | bắt buộc; mặc định `owned` |

Trường tính sẵn (chỉ đọc): `occupancyPct`, `noiMarginPct`, `vacantCount`, `unitMap`

### `/v1/property-records` — mã `HS-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `propertyCode` | mã `code` của `properties` | bắt buộc |
| `docType` | enum: `title` `survey` `inspection_report` `environmental` `insurance` `building_permit` `contractor_contract` `drawings` | bắt buộc |
| `status` | enum: `present` `missing` `needs_update` | bắt buộc; mặc định `missing` |
| `docDate` | date `YYYY-MM-DD` |  |
| `storageNote` | string (≤120) |  |

### `/v1/units` — mã `DV-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `propertyCode` | mã `code` của `properties` | bắt buộc; không sửa sau khi tạo |
| `unitCode` | string (≤20) | bắt buộc; không sửa sau khi tạo |
| `type` | string (≤30) | bắt buộc |
| `areaSqm` | number | bắt buộc |
| `bedrooms` | int |  |
| `bathrooms` | number |  |
| `listedRent` | money | chỉ ghi, không trả về |
| `vacantSince` | date `YYYY-MM-DD` |  |
| `status` | enum: `leased` `vacant` `vacating` `repair` `offline` | bắt buộc; mặc định `vacant` |

Trường tính sẵn (chỉ đọc): `vacantDays`, `activeLeaseCode`

### `/v1/leases` — mã `HD-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `propertyCode` | mã `code` của `properties` | bắt buộc |
| `unitCode` | mã `code` của `units` | bắt buộc |
| `startDate` | date `YYYY-MM-DD` | bắt buộc |
| `endDate` | date `YYYY-MM-DD` | bắt buộc |
| `monthlyRent` | money | bắt buộc; chỉ ghi, không trả về |
| `deposit` | money | chỉ ghi, không trả về |
| `renewalNote` | string (≤200) |  |
| `renewedFromCode` | mã `code` của `leases` |  |
| `status` | enum: `upcoming` `active` `expiring` `expired` `renewed` `terminated` | chỉ đọc; mặc định `upcoming` |

Trường tính sẵn (chỉ đọc): `termMonths`, `daysRemaining`, `elapsedPct`

### `/v1/rent-collections` — mã `TT-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `month` | month `YYYY-MM` | bắt buộc |
| `propertyCode` | mã `code` của `properties` | bắt buộc |
| `unitCode` | mã `code` của `units` | bắt buộc |
| `amountDue` | money | bắt buộc; chỉ ghi, không trả về |
| `amountCollected` | money | chỉ ghi, không trả về |
| `lastCollectedAt` | date `YYYY-MM-DD` |  |
| `status` | enum: `paid` `partial` `unpaid` `overdue` | chỉ đọc; mặc định `unpaid` |

Trường tính sẵn (chỉ đọc): `locked`

### `/v1/leasing-funnel` — mã `PH-…` · trường trạng thái: `step`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `propertyCode` | mã `code` của `properties` | bắt buộc |
| `unitCode` | mã `code` của `units` | bắt buộc |
| `step` | enum: `vacant` `preparing` `marketing` `inquiry` `toured` `applied` `signed` | bắt buộc; mặc định `vacant` |
| `stepEnteredAt` | date `YYYY-MM-DD` |  |
| `inquiryCount` | int | mặc định `0` |
| `tourCount` | int | mặc định `0` |
| `applicationCount` | int | mặc định `0` |
| `listedRent` | money | chỉ ghi, không trả về |

Trường tính sẵn (chỉ đọc): `vacantDays`

### `/v1/work-orders` — mã `BT-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `propertyCode` | mã `code` của `properties` | bắt buộc |
| `unitCode` | mã `code` của `units` |  |
| `category` | enum: `plumbing` `electrical` `hvac` `appliance` `roof` `landscape` `fire_safety` `other` | bắt buộc |
| `priority` | enum: `urgent` `high` `normal` | bắt buộc; mặc định `normal` |
| `title` | string (≤120) | bắt buộc |
| `description` | string (≤200) |  |
| `vendorCode` | mã `code` của `vendors` |  |
| `equipmentCode` | mã `code` của `equipment` |  |
| `estimatedCost` | money | chỉ ghi, không trả về |
| `actualCost` | money | chỉ ghi, không trả về |
| `dueDate` | date `YYYY-MM-DD` |  |
| `completedAt` | date `YYYY-MM-DD` |  |
| `status` | enum: `new` `assigned` `in_progress` `waiting_parts` `done` `cancelled` | bắt buộc; mặc định `new` |
| `sourceType` | string (≤20) | chỉ đọc |
| `sourceCode` | string (≤40) | chỉ đọc |

Trường tính sẵn (chỉ đọc): `ageDays`, `processDays`

### `/v1/pm-schedules` — mã `PM-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `propertyCode` | mã `code` của `properties` |  |
| `area` | enum: `common` |  |
| `task` | string (≤60) | bắt buộc |
| `frequency` | enum: `monthly` `quarterly` `semiannual` `annual` `seasonal` | bắt buộc |
| `lastDoneAt` | date `YYYY-MM-DD` |  |
| `firstDueAt` | date `YYYY-MM-DD` |  |
| `nextDueAt` | date `YYYY-MM-DD` | chỉ đọc |
| `vendorCode` | mã `code` của `vendors` |  |
| `status` | enum: `scheduled` `due` `in_progress` `done` `overdue` | chỉ đọc; mặc định `scheduled` |

### `/v1/vendors` — mã `NT-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `companyName` | string (≤120) | bắt buộc |
| `serviceType` | string (≤40) | bắt buộc |
| `city` | string (≤60) |  |
| `licenseNo` | string (≤40) |  |
| `licenseExpiry` | date `YYYY-MM-DD` |  |
| `insuranceExpiry` | date `YYYY-MM-DD` |  |
| `companyEmail` | string (≤120) |  |
| `companyPhone` | string (≤30) |  |
| `rating` | number |  |
| `status` | enum: `valid` `expiring` `expired` | chỉ đọc; mặc định `valid` |

### `/v1/equipment` — mã `TB-…` · trường trạng thái: `condition`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `propertyCode` | mã `code` của `properties` | bắt buộc |
| `location` | string (≤60) |  |
| `kind` | enum: `hvac` `water_heater` `pump` `elevator` `generator` `kitchen_appliance` | bắt buộc |
| `installedAt` | date `YYYY-MM-DD` | bắt buộc |
| `brand` | string (≤40) |  |
| `model` | string (≤40) |  |
| `warrantyEnd` | date `YYYY-MM-DD` |  |
| `expectedLifeYears` | number | bắt buộc |
| `condition` | enum: `good` `watch` `replace` | bắt buộc; mặc định `good` |

Trường tính sẵn (chỉ đọc): `ageYears`, `warrantyRemainingMonths`, `replaceYear`, `remainingLifePct`, `repairCount`

### `/v1/utilities` — mã `TI-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `propertyCode` | mã `code` của `properties` | bắt buộc |
| `kind` | enum: `electric` `water` `gas` `trash` `internet` | bắt buộc |
| `providerName` | string (≤80) |  |
| `period` | month `YYYY-MM` | bắt buộc |
| `usageValue` | number | bắt buộc |
| `usageUnit` | string (≤10) | bắt buộc |
| `cost` | money | chỉ ghi, không trả về |
| `status` | enum: `normal` `abnormal_rise` | chỉ đọc; mặc định `normal` |

Trường tính sẵn (chỉ đọc): `usagePerUnit`, `usagePerAreaSqm`, `momPct`, `yoyPct`, `costVsBudgetPct`

### `/v1/storm-plans` — mã `BA-…` · trường trạng thái: `responseLevel`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `propertyCode` | mã `code` của `properties` | bắt buộc |
| `responseLevel` | enum: `normal` `preparing` `in_storm` `inspecting` `damaged` `recovered` | bắt buộc; mặc định `normal` |
| `levelSince` | string (≤30) | chỉ đọc |
| `checklist` | array |  |
| ↳ `phase` | enum: `before` `during` `after` | bắt buộc |
| ↳ `text` | string (≤120) | bắt buộc |
| ↳ `done` | boolean | mặc định `false` |
| `damages` | array |  |
| ↳ `category` | string (≤40) | bắt buộc |
| ↳ `severity` | enum: `minor` `moderate` `severe` | bắt buộc |
| ↳ `count` | int | bắt buộc |

Trường tính sẵn (chỉ đọc): `checklistDonePct`, `linkedWorkOrderCount`

### `/v1/renovation-projects` — mã `CT-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `name` | string (≤120) | bắt buộc |
| `propertyCode` | mã `code` của `properties` | bắt buộc |
| `unitCode` | mã `code` của `units` |  |
| `scope` | string (≤200) |  |
| `budget` | money | chỉ ghi, không trả về |
| `actualCost` | money | chỉ ghi, không trả về |
| `vendorCode` | mã `code` của `vendors` |  |
| `startDate` | date `YYYY-MM-DD` | bắt buộc |
| `expectedEnd` | date `YYYY-MM-DD` | bắt buộc |
| `progressPct` | number (0–100) | mặc định `0` |
| `milestones` | array |  |
| ↳ `title` | string (≤120) | bắt buộc |
| ↳ `dueDate` | date `YYYY-MM-DD` |  |
| ↳ `done` | boolean | mặc định `false` |
| `status` | enum: `planned` `permitting` `in_progress` `acceptance` `done` `paused` | bắt buộc; mặc định `planned` |

Trường tính sẵn (chỉ đọc): `costVsBudgetPct`, `milestoneDone`, `milestoneTotal`

### `/v1/inspections` — mã `KT-…` · trường trạng thái: `result`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `propertyCode` | mã `code` của `properties` | bắt buộc |
| `date` | date `YYYY-MM-DD` | bắt buộc |
| `inspectorName` | string (≤40) |  |
| `category` | enum: `roof` `structure` `electrical` `plumbing` `hvac` `fire_safety` `elevator` `parking` `landscape` | bắt buộc |
| `result` | enum: `good` `watch` `urgent_fix` | bắt buộc |
| `linkedWorkOrderCode` | mã `code` của `work-orders` |  |

### `/v1/development-projects` — mã `DA-…` · trường trạng thái: `stage`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `name` | string (≤120) | bắt buộc |
| `entityCode` | mã `code` của `entities` | bắt buộc |
| `area` | string (≤80) | bắt buộc |
| `productType` | enum: `multifamily` `commercial` `single_family` | bắt buộc |
| `plannedUnits` | int | bắt buộc |
| `budget` | money | chỉ ghi, không trả về |
| `actualCost` | money | chỉ ghi, không trả về |
| `stage` | enum: `land_search` `land_purchase` `zoning` `design` `permitting` `construction` `finishing` `lease_or_sale` | bắt buộc; mặc định `land_search` |
| `stages` | array |  |
| ↳ `stage` | enum: `land_search` `land_purchase` `zoning` `design` `permitting` `construction` `finishing` `lease_or_sale` | bắt buộc |
| ↳ `plannedDate` | date `YYYY-MM-DD` |  |
| ↳ `actualDate` | date `YYYY-MM-DD` |  |
| ↳ `progressPct` | number (0–100) | mặc định `0` |
| ↳ `tasks` | array |  |
| ↳ ↳ `title` | string (≤120) | bắt buộc |
| ↳ ↳ `done` | boolean | mặc định `false` |
| `propertyCode` | mã `code` của `properties` | chỉ đọc |

Trường tính sẵn (chỉ đọc): `progressPct`, `delayDays`, `costVsBudgetPct`

### `/v1/deals` — mã `GD-…` · trường trạng thái: `stage`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `name` | string (≤120) | bắt buộc |
| `kind` | enum: `acquisition` `disposition` | bắt buộc |
| `area` | string (≤80) |  |
| `assetType` | enum: `multifamily` `single_family` `commercial` `mixed` `land` | bắt buộc |
| `listPrice` | money | chỉ ghi, không trả về |
| `offerPrice` | money | chỉ ghi, không trả về |
| `projectedNoi` | money | chỉ ghi, không trả về |
| `projectedCapRatePct` | number (0–100) |  |
| `source` | string (≤40) |  |
| `stage` | enum: `screening` `analysis` `offer` `due_diligence` `closed` `rejected` | bắt buộc; mặc định `screening` |
| `checklist` | array |  |
| ↳ `key` | enum: `legal_title` `building_inspection` `environmental` `insurance` `existing_leases` `financials` | bắt buộc |
| ↳ `status` | enum: `todo` `doing` `done` | bắt buộc; mặc định `todo` |
| ↳ `note` | string (≤120) |  |
| `unitCount` | int |  |
| `propertyCode` | mã `code` của `properties` | chỉ đọc |

Trường tính sẵn (chỉ đọc): `checklistDone`, `checklistTotal`, `projectedCapRatePct`

### `/v1/cash-flows` — mã `DT-…`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `entityCode` | mã `code` của `entities` | bắt buộc |
| `propertyCode` | mã `code` của `properties` |  |
| `direction` | enum: `income` `expense` | bắt buộc |
| `category` | enum: `rent` `other_income` `sale` `interest_income` `property_tax` `insurance` `utilities` `repairs_maintenance` `professional_fees` `management_fee` `loan_interest` `other_corporate` | bắt buộc |
| `expenseType` | enum: `operating` `capex` |  |
| `amount` | money | bắt buộc; chỉ ghi, không trả về |
| `date` | date `YYYY-MM-DD` | bắt buộc |

Trường tính sẵn (chỉ đọc): `locked`

### `/v1/budgets` — mã `NS-…`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `entityCode` | mã `code` của `entities` | bắt buộc |
| `year` | int | bắt buộc |
| `category` | enum: `rent` `other_income` `sale` `interest_income` `property_tax` `insurance` `utilities` `repairs_maintenance` `professional_fees` `management_fee` `loan_interest` `other_corporate` | bắt buộc |
| `amount` | money | bắt buộc; chỉ ghi, không trả về |

### `/v1/stress-scenarios` — mã `ST-…`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `name` | string (≤120) | bắt buộc |
| `incomeDropPct` | number (0–100) | mặc định `0` |
| `rateRisePts` | number | mặc định `0` |
| `vacancyRisePct` | number (0–100) | mặc định `0` |

### `/v1/loans` — mã `KV-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `propertyCode` | mã `code` của `properties` |  |
| `entityCode` | mã `code` của `entities` |  |
| `lenderName` | string (≤80) | bắt buộc |
| `originalPrincipal` | money | bắt buộc; chỉ ghi, không trả về |
| `currentBalance` | money | bắt buộc; chỉ ghi, không trả về |
| `ratePct` | number (0–100) |  |
| `rateType` | enum: `fixed` `floating` | bắt buộc |
| `rateSpread` | string (≤40) |  |
| `termYears` | number | bắt buộc |
| `startDate` | date `YYYY-MM-DD` | bắt buộc |
| `maturityDate` | date `YYYY-MM-DD` | bắt buộc |
| `monthlyPayment` | money | chỉ ghi, không trả về |
| `refinanceNote` | string (≤200) |  |
| `status` | enum: `current` `maturing` `paid_off` | chỉ đọc; mặc định `current` |

Trường tính sẵn (chỉ đọc): `dscr`, `ltvPct`, `elapsedPct`, `remainingDays`

### `/v1/income-entries` — mã `RV-…`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `entityCode` | mã `code` của `entities` | bắt buộc |
| `propertyCode` | mã `code` của `properties` |  |
| `period` | month `YYYY-MM` | bắt buộc |
| `group` | enum: `rent` `other` `interest` | bắt buộc |
| `amount` | money | bắt buộc; chỉ ghi, không trả về |
| `source` | enum: `auto` `manual` | chỉ đọc; mặc định `manual` |
| `reason` | string (≤120) |  |

Trường tính sẵn (chỉ đọc): `locked`

### `/v1/revenue-targets` — mã `MT-…`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `scope` | enum: `month` `quarter` `year` | bắt buộc |
| `period` | string (≤10) | bắt buộc |
| `target` | money | bắt buộc; chỉ ghi, không trả về |

Trường tính sẵn (chỉ đọc): `completionPct`

### `/v1/month-end-closes` — mã `DS-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `entityCode` | mã `code` của `entities` | bắt buộc; không sửa sau khi tạo |
| `month` | month `YYYY-MM` | bắt buộc; không sửa sau khi tạo |
| `steps` | array |  |
| ↳ `key` | string (≤40) | bắt buộc |
| ↳ `status` | enum: `todo` `doing` `done` | bắt buộc; mặc định `todo` |
| ↳ `doneByName` | string (≤40) |  |
| ↳ `doneAt` | date `YYYY-MM-DD` |  |
| ↳ `note` | string (≤120) |  |
| `status` | enum: `todo` `doing` `done` `locked` | chỉ đọc; mặc định `todo` |
| `dueDate` | date `YYYY-MM-DD` |  |

Trường tính sẵn (chỉ đọc): `completedCount`, `totalCount`, `progressPct`, `reconciliation`

### `/v1/queue-items` — mã `Q-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `type` | enum: `maintenance` `due_diligence` `lease_renewal` `vacant_unit` `loan_maturity` `closing` `storm` `warranty_expiring` `pm_due` `manual` | bắt buộc; mặc định `manual` |
| `source` | object | chỉ đọc |
| ↳ `resource` | string (≤40) | bắt buộc |
| ↳ `id` | string (≤64) | bắt buộc |
| ↳ `code` | string (≤40) | bắt buộc |
| `title` | string (≤120) | bắt buộc |
| `priority` | enum: `urgent` `high` `normal` | bắt buộc; mặc định `normal` |
| `enqueuedAt` | string (≤30) | chỉ đọc |
| `targetDueAt` | date `YYYY-MM-DD` |  |
| `assigneeName` | string (≤40) |  |
| `status` | enum: `waiting` `claimed` `in_progress` `paused` `done` | bắt buộc; mặc định `waiting` |
| `autoGenerated` | boolean | chỉ đọc |

Trường tính sẵn (chỉ đọc): `waitDays`, `isOverdue`

### `/v1/tasks` — mã `CV-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `title` | string (≤120) | bắt buộc |
| `relatedRef` | object |  |
| ↳ `resource` | string (≤40) | bắt buộc |
| ↳ `id` | string (≤64) |  |
| ↳ `code` | string (≤40) | bắt buộc |
| `dueDate` | date `YYYY-MM-DD` |  |
| `priority` | enum: `urgent` `high` `normal` | bắt buộc; mặc định `normal` |
| `status` | enum: `todo` `doing` `done` | bắt buộc; mặc định `todo` |
| `remindBeforeDays` | int |  |

Trường tính sẵn (chỉ đọc): `isOverdue`

### `/v1/partners` — mã `DOI-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `companyName` | string (≤120) | bắt buộc |
| `kind` | enum: `lender` `broker` `insurer` `title_insurer` `seller` `buyer` `investment_partner` | bắt buộc |
| `city` | string (≤60) |  |
| `website` | string (≤120) |  |
| `companyEmail` | string (≤120) |  |
| `companyPhone` | string (≤30) |  |
| `status` | enum: `active` `paused` | bắt buộc; mặc định `active` |

Trường tính sẵn (chỉ đọc): `linkedCount`

### `/v1/service-providers` — mã `NC-…` · trường trạng thái: `status`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `companyName` | string (≤120) | bắt buộc |
| `kind` | enum: `accounting` `legal` `advisor` `property_management` `bank` | bắt buộc |
| `scope` | string (≤200) |  |
| `contractStart` | date `YYYY-MM-DD` |  |
| `contractEnd` | date `YYYY-MM-DD` |  |
| `fee` | money | chỉ ghi, không trả về |
| `rating` | number |  |
| `status` | enum: `active` `expiring` `ended` | chỉ đọc; mặc định `active` |

### `/v1/scenarios` — mã `KB-…`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `toolId` | enum: `acq` `loan` `refi` `dev` `lease` `exit` `stress` `reserve` | bắt buộc |
| `name` | string (≤120) | bắt buộc |
| `target` | object |  |
| ↳ `kind` | enum: `deal` `development_project` `exit_plan` | bắt buộc |
| ↳ `code` | string (≤40) | bắt buộc |
| `ratios` | object | bắt buộc |
| `headline` | object |  |
| ↳ `label` | string (≤60) | bắt buộc |
| ↳ `value` | string (≤40) | bắt buộc |
