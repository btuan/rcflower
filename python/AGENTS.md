# Instructions for Python code

- We use `uv` for dependency management.
- ALWAYS use `uv add <dependency>` or `uv add <dependency> --dev` to add a dependency to
  this project.
- NEVER suggest using naked `pip install`, `uv pip install`, or `requirements.txt`.
- ONLY install top-level dependencies directly. Sub-dependencies should not appear in
  `pyproject.toml`, only in `uv.lock`.
- Dependencies that are specific to scripts that are run outside the normal production
  loop, such as `dev/export_model.py`, should be installed as dev dependencies.
- After adding or modifying any Python code, ALWAYS run both of the following
  from the `python/` directory (both are installed as dev dependencies):
  - `uv run pyright .` to catch type errors.
  - `uv run black .` to format.
