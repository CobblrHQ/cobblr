// What `q` reads on a customer and on an order: one list per kind, read by
// Search's resolver and by the module's own list, so a question asked in
// either finds the same records. The Customers list used to read the name,
// email and phone as one phrase while Search read every word over these,
// so "Okafor Ada" found Ada Okafor in Search and nothing in the list.
export const CUSTOMER_SEARCH = { text: ["name", "email", "phone", "address", "notes"], json: ["metadata"] } as const;
export const ORDER_SEARCH = { text: ["customer_name", "order_number", "notes", "shipping_address"], json: ["metadata"] } as const;
