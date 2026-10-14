defmodule Demo.Organization do
  use Ecto.Schema
  schema "organizations" do
    field :name, :string
    field :slug, :string
    field :plan, :string
    has_many :projects, Demo.Project
    has_many :memberships, Demo.Membership
    timestamps(type: :utc_datetime)
  end
end

defmodule Demo.User do
  use Ecto.Schema
  schema "users" do
    field :email, :string
    field :name, :string
    field :status, :string
    has_many :memberships, Demo.Membership
    timestamps(type: :utc_datetime)
  end
end

defmodule Demo.Project do
  use Ecto.Schema
  schema "projects" do
    field :name, :string
    field :archived_at, :utc_datetime
    belongs_to :organization, Demo.Organization
    belongs_to :owner, Demo.User
    has_many :tasks, Demo.Task
    timestamps(type: :utc_datetime)
  end
end

defmodule Demo.Task do
  use Ecto.Schema
  schema "tasks" do
    field :title, :string
    field :state, :string
    field :priority, :integer
    field :metadata, :map
    belongs_to :project, Demo.Project
    belongs_to :assignee, Demo.User
    has_many :comments, Demo.Comment
    timestamps(type: :utc_datetime)
  end
end

defmodule Demo.Comment do
  use Ecto.Schema
  schema "comments" do
    field :body, :string
    belongs_to :task, Demo.Task
    belongs_to :author, Demo.User
    timestamps(type: :utc_datetime)
  end
end
