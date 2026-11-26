export type BusinessProfile = 'SCHOOL' | 'UMKM' | 'DISTRIBUTOR';
export type SubscriptionTier = 'FREE' | 'PRO' | 'ENTERPRISE';
export type UserRole = 'ADMIN' | 'APPROVER' | 'OPERATOR' | 'REQUESTER';
export type AssetCondition = 'BAIK' | 'RUSAK_RINGAN' | 'RUSAK_BERAT';

export type RequestType =
  | 'INBOUND'
  | 'OUTBOUND'
  | 'ASSET_LOAN'
  | 'WRITE_OFF'
  | 'OPNAME_ADJUSTMENT'
  | 'TRANSFER'
  | 'VOID_COMPENSATION';

export type RequestStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'COMPLETED'
  | 'VOIDED';

export type ApprovalMethod =
  | 'AUTO_APPROVED'
  | 'ONLINE_REMOTE'
  | 'OFFLINE_PIN_OVERRIDE'
  | 'EMERGENCY_UNVERIFIED';

export type LedgerEventType =
  | 'INBOUND'
  | 'OUTBOUND'
  | 'ASSET_LOAN'
  | 'ASSET_RETURN'
  | 'WRITE_OFF'
  | 'OPNAME_ADJUSTMENT'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN'
  | 'PIN_OVERRIDE_APPROVED'
  | 'EMERGENCY_RELEASE'
  | 'VOID_REVERSAL';

export type OutboxEventType = LedgerEventType | 'SECURITY_PIN_LOCKOUT';

export type NetworkMode = 'ONLINE' | 'LIE_FI' | 'OFFLINE';

export interface TenantConfig {
  id: string;
  name: string;
  business_profile: BusinessProfile;
  subscription_tier: SubscriptionTier;
  approval_threshold_qty: number;
  subscription_valid_until: string;
  require_bast_signature: boolean;
}

export interface UserAccount {
  id: string;
  tenant_id: string;
  full_name: string;
  title: string;
  role: UserRole;
  offline_pin_hash?: string;
  offline_pin_salt?: string;
  qr_supervisor_token?: string;
  is_active: boolean;
}

export interface Warehouse {
  id: string;
  tenant_id: string;
  name: string;
  address: string;
  is_primary: boolean;
}

export interface BinLocation {
  id: string;
  tenant_id: string;
  warehouse_id: string;
  bin_code: string;
  description: string;
  is_frozen: boolean;
}

export interface UomConversion {
  unit_name: string;
  multiplier_to_base: number;
}

export interface ItemRecord {
  id: string;
  tenant_id: string;
  sku_code: string;
  barcode: string;
  name: string;
  category: string;
  default_bin_code: string;
  base_unit: string;
  min_stock: number;
  cost_price: number;
  is_fixed_asset: boolean;
  asset_condition: AssetCondition;
  uoms: UomConversion[];
  updated_at: string;
}

export type OperatorItemView = Omit<ItemRecord, 'cost_price'>;

export interface BatchBalance {
  id: string;
  tenant_id: string;
  warehouse_id: string;
  bin_code: string;
  item_id: string;
  batch_number: string;
  expiry_date?: string;
  qty_on_hand: number;
  qty_reserved: number;
  updated_at: string;
}

export interface StockRequest {
  id: string;
  tenant_id: string;
  warehouse_id: string;
  target_warehouse_id?: string;
  request_code: string;
  request_type: RequestType;
  item_id: string;
  batch_number: string;
  qty_requested_base: number;
  qty_approved_base?: number;
  uom_used: string;
  party_name: string;
  reason: string;
  rejection_reason?: string;
  status: RequestStatus;
  requested_by: string;
  requested_by_name: string;
  approved_by?: string;
  approved_by_name?: string;
  approval_method?: ApprovalMethod;
  is_flagged_unverified: boolean;
  evidence_photo_data_url?: string;
  evidence_photo_name?: string;
  evidence_size_kb?: number;
  signature_data_url?: string;
  due_return_date?: string;
  returned_condition?: AssetCondition;
  created_at: string;
  synced_at?: string;
}

export interface LedgerEntry {
  id: string;
  tenant_id: string;
  warehouse_id: string;
  item_id: string;
  request_id?: string;
  batch_number: string;
  event_type: LedgerEventType;
  qty_delta: number;
  is_overdraft_flagged: boolean;
  is_unverified_flagged: boolean;
  actor_id: string;
  actor_name: string;
  approval_method: string;
  device_origin: string;
  notes?: string;
  created_at: string;
  synced_at?: string;
}

export interface OutboxEvent {
  id: string;
  tenant_id: string;
  warehouse_id: string;
  item_id: string;
  request_id?: string;
  batch_number: string;
  event_type: OutboxEventType;
  qty_delta: number;
  actor_id: string;
  actor_name: string;
  approval_method: string;
  device_origin: string;
  notes?: string;
  media_stage_status: 'NONE' | 'PENDING_MEDIA' | 'MEDIA_UPLOADED';
  evidence_photo_data_url?: string;
  created_at: string;
  retry_count: number;
}

export interface AuditLogEntry {
  id: string;
  tenant_id: string;
  actor_id: string;
  actor_name: string;
  action_type: string;
  target_id: string;
  summary: string;
  created_at: string;
}
