# Auth Backend (Node.js + Express)

## Setup
1. Open terminal in `backend`
2. Install dependencies:
   - `npm install`
3. Start server:
   - `npm start`

Server runs on: `http://localhost:4000`

## Endpoints

### `POST /auth/register`
Body:
```json
{
  "name": "Shiva",
  "email": "shiva@example.com",
  "password": "StrongPassword123"
}
```

### `POST /auth/login`
Body:
```json
{
  "email": "shiva@example.com",
  "password": "StrongPassword123"
}
```

### `POST /auth/logout`
No body. Clears login session cookie.

### `GET /auth/me`
Returns logged-in user from session cookie.

### `POST /orders`
Creates an order for the logged-in user.
Body:
```json
{
  "customer": {
    "name": "Shiva",
    "phone": "9999999999",
    "email": "shiva@example.com",
    "address": "Varanasi",
    "city": "Varanasi",
    "state": "UP",
    "pinCode": "221001",
    "note": ""
  },
  "items": [
    {
      "id": "prd-1",
      "title": "Instrument 01",
      "category": "Accessories",
      "qty": 1
    }
  ]
}
```

### `GET /orders/me`
Returns all orders for the logged-in user.

## Notes
- Users, sessions, and orders are stored in SQLite DB: `backend/data/app.db`.
- Passwords are hashed with `bcryptjs`.
- Cookie is HTTP-only (`ddd_sid`).
