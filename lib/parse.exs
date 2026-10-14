# Parse syntax only. Repository modules, macros and migration functions are never run.
defmodule AtlasParser do
  def node({name, meta, args}, depth) when is_list(meta) and depth < 160 do
    %{"call" => node(name, depth + 1), "line" => Keyword.get(meta, :line, 1), "args" => node(args, depth + 1)}
  end
  def node(value, depth) when is_tuple(value) and depth < 160, do: value |> Tuple.to_list() |> Enum.map(&node(&1, depth + 1))
  def node(value, depth) when is_list(value) and depth < 160, do: Enum.map(value, &node(&1, depth + 1))
  def node(value, _) when is_boolean(value) or is_nil(value) or is_number(value), do: value
  def node(value, _) when is_binary(value), do: (if String.valid?(value), do: value, else: %{"binary_literal" => Base.encode16(value)})
  def node(value, _) when is_atom(value), do: %{"atom" => Atom.to_string(value)}
  def node(_, _), do: %{"unsupported" => true}

  def main do
    Process.flag(:max_heap_size, %{size: 16_000_000, kill: true, error_logger: false})
    bytes = IO.read(:stdio, 12_000_001)
    if not is_binary(bytes) or byte_size(bytes) > 12_000_000, do: System.halt(2)
    files = :json.decode(bytes)
    if not is_list(files) or length(files) > 2000, do: System.halt(2)
    results = Enum.map(files, fn file ->
      content = file["content"]
      path = file["path"]
      if not is_binary(content) or byte_size(content) > 1_000_000 or not is_binary(path) or byte_size(path) > 1024, do: System.halt(2)
      if not String.valid?(content), do: System.halt(2)
      # Each fresh VM bounds atom lifetime; the parent enforces timeout and output size.
      result = case Code.string_to_quoted(content, columns: true) do
        {:ok, ast} -> %{"ast" => node(ast, 0)}
        {:error, {meta, _, _}} -> %{"error" => "Elixir syntax could not be parsed", "line" => (if is_list(meta), do: Keyword.get(meta, :line, 1), else: 1)}
      end
      Map.merge(result, %{"path" => path, "kind" => file["kind"]})
    end)
    IO.write(:json.encode(results))
  end
end
AtlasParser.main()
