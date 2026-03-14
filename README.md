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

### `GET /products`
Public endpoint to fetch all products for inventory pages.

### `POST /products`
Authenticated endpoint to add a product.

### `PUT /products/:id`
Authenticated endpoint to update a product.

### `DELETE /products/:id`
Authenticated endpoint to delete a product.

### `GET /wishlist`
Returns wishlist items for the logged-in user.

### `POST /wishlist`
Adds a product to the wishlist.
Body:
```json
{
  "productId": "prd-1"
}
```

### `DELETE /wishlist/:productId`
Removes a product from the wishlist.

## Notes
- Local uses SQLite: `backend/data/app.db`.
- Production (when `DATABASE_URL` is set) uses Postgres.
- Health check shows current DB: `GET /health` -> `{ ok: true, db: "sqlite" | "postgres" }`.
- After adding wishlist support, restart local server or redeploy production so the wishlist table is created.
- Passwords are hashed with `bcryptjs`.
- Cookie is HTTP-only (`ddd_sid`).



