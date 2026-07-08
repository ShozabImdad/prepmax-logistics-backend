// The authenticated principal attached to each request (req.auth).
// Either a staff user (super_admin | branch_manager) or a customer.

export type StaffRole = "super_admin" | "branch_manager";

export interface StaffPrincipal {
  kind: "user";
  userId: string;
  publicId: string;
  role: StaffRole;
  branchId: string | null;    // null for super_admin
  email: string;
  fullName: string;
  permissions: Set<string>;   // effective permission keys (super_admin = all)
}

export interface CustomerPrincipal {
  kind: "customer";
  customerId: string;
  publicId: string;
  branchId: string;
  email: string;
  fullName: string;
}

export type Principal = StaffPrincipal | CustomerPrincipal;

export function isStaff(p: Principal | undefined): p is StaffPrincipal {
  return p?.kind === "user";
}
export function isCustomer(p: Principal | undefined): p is CustomerPrincipal {
  return p?.kind === "customer";
}
