-- Estimated delivery window: computed once an order is activated (first
-- carrier leg attached, per orders.attachLegs()). Derived from the service
-- type/option chosen at booking (see orders/delivery-times.ts) plus working
-- days from the activation date. Nullable — unset until activation.
ALTER TABLE orders
  ADD COLUMN estimated_delivery_min date,
  ADD COLUMN estimated_delivery_max date;
