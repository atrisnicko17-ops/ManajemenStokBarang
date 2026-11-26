-- ============================================================================
-- 003_sync_rpc.sql
-- GudangKu WMS — Atomic Offline Sync Queue RPC, Deadlock-Safe Row Locking,
-- Overdraft Detection, & Admin Cost Valuation RPC
-- ============================================================================

-- 1. RPC KHUSUS ADMIN: BACA MASTER BARANG BESERTA HPP (cost_price)
CREATE OR REPLACE FUNCTION public.get_admin_items_with_cost()
RETURNS SETOF public.items
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
    v_uid UUID := (SELECT auth.uid());
    v_tenant_id UUID;
    v_role VARCHAR(20);
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'UNAUTHORIZED: Sesi login diperlukan.';
    END IF;

    SELECT u.tenant_id, u.role INTO v_tenant_id, v_role
    FROM public.users u
    WHERE u.id = v_uid AND u.is_active = TRUE;

    IF v_role IS DISTINCT FROM 'ADMIN' THEN
        RAISE EXCEPTION 'FORBIDDEN_HPP_ACCESS: Hanya peran ADMIN/OWNER yang berhak mengakses nilai HPP.';
    END IF;

    RETURN QUERY
    SELECT *
    FROM public.items i
    WHERE i.tenant_id = v_tenant_id
    ORDER BY i.sku_code ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_items_with_cost() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_items_with_cost() TO authenticated;

-- 2. RPC SINKRONISASI BATCH OFFLINE ATOMIK & BEBAS DEADLOCK
CREATE OR REPLACE FUNCTION public.process_offline_sync_batch(p_events JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_uid UUID := (SELECT auth.uid());
    v_tenant_id UUID;
    v_role VARCHAR(20);
    v_event JSONB;
    v_event_id UUID;
    v_item_id UUID;
    v_warehouse_id UUID;
    v_batch VARCHAR(60);
    v_event_type VARCHAR(30);
    v_delta INT;
    v_current_qty INT;
    v_is_overdraft BOOLEAN;
    v_is_unverified BOOLEAN;
    v_processed_count INT := 0;
    v_skipped_count INT := 0;
    v_overdraft_count INT := 0;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'UNAUTHORIZED: Sesi autentikasi tidak ditemukan.';
    END IF;

    SELECT u.tenant_id, u.role INTO v_tenant_id, v_role
    FROM public.users u
    WHERE u.id = v_uid AND u.is_active = TRUE;

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'FORBIDDEN: Pengguna tidak terdaftar pada tenant aktif.';
    END IF;

    IF jsonb_typeof(p_events) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'INVALID_PAYLOAD: p_events harus berupa JSON array.';
    END IF;

    -- Urutkan penguncian baris saldo secara deterministik (warehouse_id, item_id, batch_number)
    -- untuk mencegah Deadlock saat 2 HP staf melakukan sinkronisasi bersamaan
    PERFORM 1
    FROM public.inventory_balances ib
    JOIN (
        SELECT DISTINCT
            (e->>'warehouse_id')::UUID AS warehouse_id,
            (e->>'item_id')::UUID AS item_id,
            COALESCE(NULLIF(e->>'batch_number', ''), 'GENERAL') AS batch_number
        FROM jsonb_array_elements(p_events) AS e
        WHERE (e->>'item_id') IS NOT NULL AND (e->>'warehouse_id') IS NOT NULL
    ) targets
      ON ib.warehouse_id = targets.warehouse_id
     AND ib.item_id = targets.item_id
     AND ib.batch_number = targets.batch_number
    WHERE ib.tenant_id = v_tenant_id
    ORDER BY ib.warehouse_id, ib.item_id, ib.batch_number
    FOR UPDATE;

    -- Proses setiap event sesuai urutan waktu pembuatan UUIDv7 / created_at
    FOR v_event IN
        SELECT elem
        FROM jsonb_array_elements(p_events) AS elem
        ORDER BY (elem->>'created_at')::TIMESTAMPTZ ASC, (elem->>'id') ASC
    LOOP
        v_event_id := (v_event->>'id')::UUID;
        v_event_type := v_event->>'event_type';

        -- Event keamanan khusus: log percobaan salah PIN 3x saat offline
        IF v_event_type = 'SECURITY_PIN_LOCKOUT' THEN
            INSERT INTO public.audit_logs (tenant_id, actor_id, action_type, target_id, metadata)
            VALUES (
                v_tenant_id,
                v_uid,
                'SECURITY_PIN_LOCKOUT',
                v_event->>'device_origin',
                v_event
            );
            v_processed_count := v_processed_count + 1;
            CONTINUE;
        END IF;

        -- Cek Idempotency: jika event UUIDv7 sudah tercatat di stock_ledger, lewati
        IF EXISTS (SELECT 1 FROM public.stock_ledger sl WHERE sl.id = v_event_id) THEN
            v_skipped_count := v_skipped_count + 1;
            CONTINUE;
        END IF;

        v_item_id := (v_event->>'item_id')::UUID;
        v_warehouse_id := (v_event->>'warehouse_id')::UUID;
        v_batch := COALESCE(NULLIF(v_event->>'batch_number', ''), 'GENERAL');
        v_delta := (v_event->>'qty_delta')::INT;

        -- Validasi kepemilikan gudang & item terhadap tenant pemanggil (Anti-IDOR)
        IF NOT EXISTS (
            SELECT 1 FROM public.warehouses w WHERE w.id = v_warehouse_id AND w.tenant_id = v_tenant_id
        ) OR NOT EXISTS (
            SELECT 1 FROM public.items i WHERE i.id = v_item_id AND i.tenant_id = v_tenant_id
        ) THEN
            RAISE EXCEPTION 'TENANT_ISOLATION_VIOLATION: Item atau gudang bukan milik organisasi Anda.';
        END IF;

        SELECT ib.qty_on_hand INTO v_current_qty
        FROM public.inventory_balances ib
        WHERE ib.tenant_id = v_tenant_id
          AND ib.warehouse_id = v_warehouse_id
          AND ib.item_id = v_item_id
          AND ib.batch_number = v_batch
        FOR UPDATE;

        IF v_current_qty IS NULL THEN
            v_current_qty := 0;
            INSERT INTO public.inventory_balances (
                tenant_id, warehouse_id, item_id, batch_number, qty_on_hand
            ) VALUES (
                v_tenant_id, v_warehouse_id, v_item_id, v_batch, 0
            );
        END IF;

        -- Deteksi stok minus akibat transaksi offline bersamaan (Overdraft)
        v_is_overdraft := (v_current_qty + v_delta) < 0;
        v_is_unverified := COALESCE(v_event->>'approval_method', '') = 'EMERGENCY_UNVERIFIED';

        UPDATE public.inventory_balances
        SET qty_on_hand = qty_on_hand + v_delta,
            updated_at = NOW()
        WHERE tenant_id = v_tenant_id
          AND warehouse_id = v_warehouse_id
          AND item_id = v_item_id
          AND batch_number = v_batch;

        INSERT INTO public.stock_ledger (
            id, tenant_id, warehouse_id, item_id, batch_number,
            event_type, qty_delta, is_overdraft_flagged, is_unverified_flagged,
            actor_id, approval_method, device_origin, notes, created_at
        ) VALUES (
            v_event_id,
            v_tenant_id,
            v_warehouse_id,
            v_item_id,
            v_batch,
            v_event_type,
            v_delta,
            v_is_overdraft,
            v_is_unverified,
            v_uid,
            v_event->>'approval_method',
            v_event->>'device_origin',
            v_event->>'notes',
            (v_event->>'created_at')::TIMESTAMPTZ
        );

        IF v_is_overdraft THEN
            v_overdraft_count := v_overdraft_count + 1;
            INSERT INTO public.audit_logs (tenant_id, actor_id, action_type, target_id, metadata)
            VALUES (
                v_tenant_id,
                v_uid,
                'FLAGGED_OVERDRAFT',
                v_event_id::TEXT,
                jsonb_build_object(
                    'item_id', v_item_id,
                    'warehouse_id', v_warehouse_id,
                    'previous_qty', v_current_qty,
                    'qty_delta', v_delta,
                    'resulting_qty', v_current_qty + v_delta
                )
            );
        END IF;

        v_processed_count := v_processed_count + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'status', 'SUCCESS',
        'processed_count', v_processed_count,
        'skipped_count', v_skipped_count,
        'overdraft_count', v_overdraft_count,
        'server_timestamp', NOW()
    );
END;
$$;

REVOKE ALL ON FUNCTION public.process_offline_sync_batch(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_offline_sync_batch(JSONB) TO authenticated;
