// Shared KB generation prompt — Vietnamese intentional (content goes into project files)
export const KB_GEN_PROMPT = `Đọc toàn bộ codebase trong thư mục hiện tại và tạo file KNOWLEDGE.md theo format sau:

# {Tên project} — Knowledge Base

## 0. Mô tả hệ thống
[Mô tả tổng quan: mục tiêu, users chính, business value]

| Thuộc tính | Giá trị |
|---|---|
| Runtime chính | [language/framework] |
| Kiến trúc | [architecture pattern: Clean Arch / MVC / ...] |
| Database | [databases used] |
| Giao tiếp | [REST / Kafka / gRPC / ...] |
| Môi trường | [local / staging / prod] |

## 1. Mục lục module chính

| # | Module/File | Nội dung |
|---|---|---|
[Liệt kê tất cả modules/services chính]

## 2. Sơ đồ kiến trúc tổng quan
\`\`\`
[ASCII diagram hoặc mô tả luồng dữ liệu chính giữa các module]
\`\`\`

### Luồng chính (typical flow):
\`\`\`
[User action] → [Module A] → [Module B] → [Module C] → [Result]
\`\`\`

## 3. Quy tắc vàng (hard rules)
[Liệt kê các quy tắc KHÔNG được vi phạm — R1, R2, R3...]

### R1 — [Tên rule]
- **Sai**: [ví dụ vi phạm]
- **Đúng**: [cách đúng]

## 4. Hướng dẫn onboarding agent

### Khi bắt đầu session mới — đọc theo thứ tự:
\`\`\`
1. KNOWLEDGE.md (file này) — hiểu toàn cảnh
2. README.md — setup & run
3. Module liên quan đến task
\`\`\`

### Tra cứu nhanh theo loại task:
| Task | File cần đọc trước |
|---|---|
| Thêm feature | README → module liên quan |
| Fix bug | Module chứa bug → test file |
| Refactor | Architecture docs → module |
| Security audit | Hard rules → auth module |

## 5. Checklist triển khai
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Không hardcode secrets
- [ ] API backward compatible
- [ ] Migration scripts tested

## 6. Liên kết nhanh
| Tôi cần... | Đọc file này |
|---|---|
| Hiểu module X làm gì | Module X README |
| Biết cách đặt tên | CONVENTIONS.md |
| Biết secret ở đâu | DEPLOYMENT.md |
| Debug lỗi production | RUNBOOK.md |`;
