defmodule Demo.Repo.Migrations.AddAuditEvents do
  use Ecto.Migration

  def up do
    create table(:audit_events, primary_key: false, options: "PARTITION BY RANGE (occurred_at)", comment: "Append-only workspace activity, partitioned by month") do
      add :id, :uuid, primary_key: true
      add :occurred_at, :utc_datetime, primary_key: true
      add :organization_id, references(:organizations), null: false
      add :actor_id, references(:users)
      add :event_type, :string, null: false
      add :payload, :map, null: false
    end
    create index(:audit_events, [:organization_id, :occurred_at])
    execute "CREATE TABLE audit_events_2026_10 PARTITION OF audit_events FOR VALUES FROM ('2026-10-01') TO ('2026-11-01')"
  end

  def down do
    drop table(:audit_events)
  end
end
