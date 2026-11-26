-- ============================================================================
-- 001_init_schema.sql
-- GudangKu WMS — Core Multi-Tenant Schema, FK Indexes, Immutable Triggers,
-- & Column-Level HPP Isolation
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Skema privat untuk fungsi helper internal (mencegah eksposur SECURITY DEFINER ke PUBLIC)
CREATE SCHEMA IF NOT EXISTS private;

-- 1. TABEL ORGANISASI / CLIENT SAAS (MULTI-TENANT)
CREATE TABLE public.tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL,
    business_profile VARCHAR(20) NOT NULL CHECK (business_profile IN ('SCHOOL', 'UMKM', 'DISTRIBUTOR')),
    subscription_tier VARCHAR(20) NOT NULL DEFAULT 'FREE' CHECK (subscription_tier IN ('FREE', 'PRO', 'ENTERPRISE')),
    approval_threshold_qty INT NOT NULL DEFAULT 5 CHECK (approval_threshold_qty >= 0),
    subscription_valid_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. TABEL PENGGUNA & HAK AKSES (RBAC)
CREATE TABLE public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    full_name VARCHAR(120) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'APPROVER', 'OPERATOR', 'REQUESTER')),
    offline_pin_hash TEXT CHECK (offline_pin_hash IS NULL OR offline_pin_hash ~ '^[a-f0-9]{64}$'),
    offline_pin_salt TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_tenant_id ON public.users(tenant_id);

-- 3. TABEL GUDANG & LOKASI RAK (BIN LOCATION)
CREATE TABLE public.warehouses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    address TEXT,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_warehouses_tenant_id ON public.warehouses(tenant_id);

CREATE TABLE public.bin_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    warehouse_id UUID NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
    bin_code VARCHAR(50) NOT NULL,
    description VARCHAR(150),
    is_frozen BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE(warehouse_id, bin_code)
);

CREATE INDEX idx_bin_locations_tenant_id ON public.bin_locations(tenant_id);
CREATE INDEX idx_bin_locations_warehouse_id ON public.bin_locations(warehouse_id);

-- 4. MASTER BARANG (SKU)
CREATE TABLE public.items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    sku_code VARCHAR(60) NOT NULL,
    barcode VARCHAR(100),
    name VARCHAR(200) NOT NULL,
    category VARCHAR(100),
    default_bin_code VARCHAR(50) NOT NULL DEFAULT 'ZONA-A/RAK-01',
    base_unit VARCHAR(30) NOT NULL,
    min_stock INT NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
    cost_price NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
    is_fixed_asset BOOLEAN NOT NULL DEFAULT FALSE,
    asset_condition VARCHAR(20) NOT NULL DEFAULT 'BAIK' CHECK (asset_condition IN ('BAIK', 'RUSAK_RINGAN', 'RUSAK_BERAT')),
    image_url TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, sku_code)
);

CREATE INDEX idx_items_tenant_barcode ON public.items(tenant_id, barcode);
CREATE INDEX idx_items_tenant_updated_at ON public.items(tenant_id, updated_at DESC);

-- 5. KONVERSI SATUAN BERTINGKAT (MULTI-UOM)
CREATE TABLE public.item_uoms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
    unit_name VARCHAR(40) NOT NULL,
    multiplier_to_base INT NOT NULL CHECK (multiplier_to_base >= 1),
    UNIQUE(item_id, unit_name)
);

CREATE INDEX idx_item_uoms_tenant_id ON public.item_uoms(tenant_id);
CREATE INDEX idx_item_uoms_item_id ON public.item_uoms(item_id);

-- 6. SALDO STOK PER GUDANG & BATCH (MENDUKUNG FIFO / FEFO)
CREATE TABLE public.inventory_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    warehouse_id UUID NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
    bin_id UUID REFERENCES public.bin_locations(id) ON DELETE SET NULL,
    item_id UUID NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
    batch_number VARCHAR(60) NOT NULL DEFAULT 'GENERAL',
    expiry_date DATE,
    qty_on_hand INT NOT NULL DEFAULT 0,
    qty_reserved INT NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(warehouse_id, item_id, batch_number)
);

CREATE INDEX idx_balances_tenant_id ON public.inventory_balances(tenant_id);
CREATE INDEX idx_balances_warehouse_item ON public.inventory_balances(warehouse_id, item_id);
CREATE INDEX idx_balances_bin_id ON public.inventory_balances(bin_id);
CREATE INDEX idx_balances_fefo ON public.inventory_balances(tenant_id, item_id, expiry_date ASC NULLS LAST);

-- 7. DOKUMEN PERMINTAAN & PERSETUJUAN (APPROVAL WORKFLOW & BAST)
CREATE TABLE public.stock_requests (
    id UUID PRIMARY KEY, -- Client-generated UUIDv7
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    warehouse_id UUID NOT NULL REFERENCES public.warehouses(id) ON DELETE RESTRICT,
    target_warehouse_id UUID REFERENCES public.warehouses(id) ON DELETE RESTRICT,
    request_code VARCHAR(40) NOT NULL,
    request_type VARCHAR(25) NOT NULL CHECK (
        request_type IN ('INBOUND', 'OUTBOUND', 'ASSET_LOAN', 'WRITE_OFF', 'OPNAME_ADJUSTMENT', 'TRANSFER', 'VOID_COMPENSATION')
    ),
    item_id UUID NOT NULL REFERENCES public.items(id) ON DELETE RESTRICT,
    batch_number VARCHAR(60) NOT NULL DEFAULT 'GENERAL',
    qty_requested_base INT NOT NULL,
    qty_approved_base INT,
    uom_used VARCHAR(40),
    party_name VARCHAR(150),
    reason TEXT,
    rejection_reason TEXT,
    status VARCHAR(25) NOT NULL CHECK (
        status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'COMPLETED', 'VOIDED')
    ),
    requested_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    approved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    approval_method VARCHAR(30) CHECK (
        approval_method IS NULL OR approval_method IN (
            'AUTO_APPROVED', 'ONLINE_REMOTE', 'OFFLINE_PIN_OVERRIDE', 'EMERGENCY_UNVERIFIED'
        )
    ),
    is_flagged_unverified BOOLEAN NOT NULL DEFAULT FALSE,
    evidence_photo_url TEXT,
    signature_url TEXT,
    due_return_date DATE,
    returned_condition VARCHAR(20) CHECK (
        returned_condition IS NULL OR returned_condition IN ('BAIK', 'RUSAK_RINGAN', 'RUSAK_BERAT')
    ),
    created_at TIMESTAMPTZ NOT NULL,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_requests_tenant_status ON public.stock_requests(tenant_id, status, created_at DESC);
CREATE INDEX idx_requests_warehouse_id ON public.stock_requests(warehouse_id);
CREATE INDEX idx_requests_target_warehouse_id ON public.stock_requests(target_warehouse_id);
CREATE INDEX idx_requests_item_id ON public.stock_requests(item_id);
CREATE INDEX idx_requests_requested_by ON public.stock_requests(requested_by);
CREATE INDEX idx_requests_approved_by ON public.stock_requests(approved_by);

-- 8. BUKU BESAR MUTASI STOK (IMMUTABLE EVENT LEDGER)
CREATE TABLE public.stock_ledger (
    id UUID PRIMARY KEY, -- Client Idempotency UUIDv7
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    warehouse_id UUID NOT NULL REFERENCES public.warehouses(id) ON DELETE RESTRICT,
    item_id UUID NOT NULL REFERENCES public.items(id) ON DELETE RESTRICT,
    request_id UUID REFERENCES public.stock_requests(id) ON DELETE SET NULL,
    batch_number VARCHAR(60) NOT NULL DEFAULT 'GENERAL',
    event_type VARCHAR(30) NOT NULL CHECK (
        event_type IN (
            'INBOUND', 'OUTBOUND', 'ASSET_LOAN', 'ASSET_RETURN',
            'WRITE_OFF', 'OPNAME_ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN',
            'PIN_OVERRIDE_APPROVED', 'EMERGENCY_RELEASE', 'VOID_REVERSAL'
        )
    ),
    qty_delta INT NOT NULL CHECK (qty_delta <> 0),
    is_overdraft_flagged BOOLEAN NOT NULL DEFAULT FALSE,
    is_unverified_flagged BOOLEAN NOT NULL DEFAULT FALSE,
    actor_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    approval_method VARCHAR(30),
    device_origin VARCHAR(100),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ledger_tenant_created ON public.stock_ledger(tenant_id, created_at DESC);
CREATE INDEX idx_ledger_warehouse_id ON public.stock_ledger(warehouse_id);
CREATE INDEX idx_ledger_item_id ON public.stock_ledger(item_id);
CREATE INDEX idx_ledger_request_id ON public.stock_ledger(request_id);
CREATE INDEX idx_ledger_actor_id ON public.stock_ledger(actor_id);

-- 9. AUDIT LOG KEAMANAN & TATA KELOLA (IMMUTABLE)
CREATE TABLE public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    action_type VARCHAR(50) NOT NULL,
    target_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_tenant_created ON public.audit_logs(tenant_id, created_at DESC);
CREATE INDEX idx_audit_logs_actor_id ON public.audit_logs(actor_id);

-- 10. TRIGGER IMMUTABILITY (ANTI-EDIT & ANTI-DELETE PADA BUKU BESAR & AUDIT LOG)
CREATE OR REPLACE FUNCTION private.enforce_immutable_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION 'IMMUTABLE_LEDGER_VIOLATION: Catatan pada % bersifat permanen dan tidak dapat diubah atau dihapus. Gunakan prosedur VOID.', TG_TABLE_NAME;
END;
$$;

REVOKE ALL ON FUNCTION private.enforce_immutable_ledger() FROM PUBLIC;

CREATE TRIGGER trg_stock_ledger_immutable
BEFORE UPDATE OR DELETE ON public.stock_ledger
FOR EACH ROW EXECUTE FUNCTION private.enforce_immutable_ledger();

CREATE TRIGGER trg_audit_logs_immutable
BEFORE UPDATE OR DELETE ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION private.enforce_immutable_ledger();

-- 11. SECURE VIEW UNTUK STAF LAPANGAN (WITH security_invoker = true)
-- Memastikan RLS pemanggil tetap dievaluasi dan kolom cost_price tidak pernah terekspos
CREATE VIEW public.v_items_operator
WITH (security_invoker = true) AS
SELECT
    id,
    tenant_id,
    sku_code,
    barcode,
    name,
    category,
    default_bin_code,
    base_unit,
    min_stock,
    is_fixed_asset,
    asset_condition,
    image_url,
    updated_at
FROM public.items;
