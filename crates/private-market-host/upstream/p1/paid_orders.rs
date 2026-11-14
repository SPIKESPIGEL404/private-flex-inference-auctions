//! Opt-in controlled native payment constraints, owned by the original PG layer.
use super::*;
pub fn enabled() -> bool {
    std::env::var("PRIVATE_MARKET_NEAR_DIRECT_P1").as_deref() == Ok("controlled")
}
pub(super) async fn install(db: &impl ConnectionTrait) -> Result<()> {
    if enabled() {
        db.execute_unprepared(include_str!("paid_orders.sql"))
            .await?;
        let hash = fingerprint(db).await?;
        db.execute(sql(
            "INSERT INTO public.mpp_direct_schema VALUES(true,$1)",
            vec![hash.into()],
        ))
        .await?;
    }
    Ok(())
}
pub(super) async fn verify(db: &impl ConnectionTrait) -> Result<()> {
    let present = db
        .query_one(sql(
            "SELECT to_regclass('public.mpp_direct_orders') IS NOT NULL AS found",
            vec![],
        ))
        .await?
        .context("paid mode probe")?
        .try_get::<bool>("", "found")?;
    ensure!(
        present == enabled(),
        "controlled direct-payment mode differs from original schema"
    );
    if present {
        let expected = db
            .query_one(sql(
                "SELECT fingerprint FROM public.mpp_direct_schema WHERE singleton",
                vec![],
            ))
            .await?
            .context("MPP direct schema marker missing")?
            .try_get::<String>("", "fingerprint")?;
        ensure!(
            expected == fingerprint(db).await?,
            "MPP direct financial schema changed"
        );
    }
    Ok(())
}

async fn fingerprint(db: &impl ConnectionTrait) -> Result<String> {
    let row=db.query_one(sql(r#"
      WITH relations AS (
        SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND starts_with(c.relname,'mpp_direct_')
      ), defs AS (
        SELECT 'column' AS kind,r.relname::text AS rel,a.attname::text AS name,
          concat_ws('|',a.attnum,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) AS definition
        FROM relations r JOIN pg_attribute a ON a.attrelid=r.oid LEFT JOIN pg_attrdef d ON d.adrelid=r.oid AND d.adnum=a.attnum WHERE a.attnum>0 AND NOT a.attisdropped
        UNION ALL SELECT 'constraint',r.relname,k.conname,pg_get_constraintdef(k.oid) FROM relations r JOIN pg_constraint k ON k.conrelid=r.oid
        UNION ALL SELECT 'index',r.relname,c.relname,pg_get_indexdef(i.indexrelid) FROM relations r JOIN pg_index i ON i.indrelid=r.oid JOIN pg_class c ON c.oid=i.indexrelid
        UNION ALL SELECT 'trigger',c.relname,t.tgname,concat_ws('|',t.tgenabled,pg_get_triggerdef(t.oid)) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE starts_with(t.tgname,'mpp_direct_')
        UNION ALL SELECT 'function',n.nspname,p.proname,pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND starts_with(p.proname,'mpp_direct_')
      ) SELECT jsonb_agg(jsonb_build_array(kind,rel,name,definition) ORDER BY kind COLLATE "C",rel COLLATE "C",name COLLATE "C",definition COLLATE "C") AS value FROM defs
    "#,vec![])).await?.context("MPP schema fingerprint")?;
    Ok(digest(&bounded(&row.try_get::<Value>("", "value")?)?))
}
pub async fn request_identity(
    db: &DatabaseConnection,
    user: &str,
    key: &str,
) -> Result<Option<String>> {
    if !enabled() {
        return Ok(None);
    }
    let row = db
        .query_one(sql(
            "SELECT native_id FROM public.mpp_direct_orders WHERE user_id=$1 AND dispatch_key=$2",
            vec![user.into(), key.into()],
        ))
        .await?
        .context("paid original order required")?;
    Ok(Some(row.try_get("", "native_id")?))
}
