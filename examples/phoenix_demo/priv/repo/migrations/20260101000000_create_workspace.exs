defmodule Demo.Repo.Migrations.CreateWorkspace do
  use Ecto.Migration

  def change do
    create table(:organizations, comment: "Tenant workspaces and billing identity") do
      add :name, :string, null: false
      add :slug, :string, null: false
      add :plan, :string, default: "free", null: false
      timestamps(type: :utc_datetime)
    end
    create unique_index(:organizations, [:slug])

    create table(:users, comment: "People who can access a workspace") do
      add :email, :string, null: false
      add :name, :string
      add :status, :string, default: "active", null: false
      timestamps(type: :utc_datetime)
    end
    create unique_index(:users, ["lower(email)"], name: :users_email_unique)
    create index(:users, [:status], where: "status = 'active'")

    create table(:memberships) do
      add :organization_id, references(:organizations, on_delete: :delete_all), null: false
      add :user_id, references(:users, on_delete: :delete_all), null: false
      add :role, :string, default: "member", null: false
      timestamps(type: :utc_datetime)
    end
    create unique_index(:memberships, [:organization_id, :user_id])
    create constraint(:memberships, :valid_role, check: "role IN ('owner', 'admin', 'member')")

    create table(:projects) do
      add :organization_id, references(:organizations, on_delete: :delete_all), null: false
      add :owner_id, references(:users, on_delete: :nilify_all)
      add :name, :string, null: false
      add :archived_at, :utc_datetime
      timestamps(type: :utc_datetime)
    end
    create index(:projects, [:organization_id, :name], include: [:owner_id])

    create table(:tasks) do
      add :project_id, references(:projects, on_delete: :delete_all), null: false
      add :assignee_id, references(:users, on_delete: :nilify_all)
      add :title, :string, null: false
      add :state, :string, default: "open", null: false
      add :priority, :integer, default: 0, null: false
      add :metadata, :map, default: %{}
      timestamps(type: :utc_datetime)
    end
    create index(:tasks, [:project_id, :state])
    create index(:tasks, [:metadata], using: :gin)
    create constraint(:tasks, :priority_range, check: "priority BETWEEN 0 AND 4")

    create table(:comments) do
      add :task_id, references(:tasks, on_delete: :delete_all), null: false
      add :author_id, references(:users, on_delete: :nilify_all)
      add :body, :text, null: false
      timestamps(type: :utc_datetime)
    end
    create index(:comments, [:task_id, :inserted_at])
  end
end
