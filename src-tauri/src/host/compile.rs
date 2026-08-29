use std::fs;
use std::path::{Path, PathBuf};

use oxc::allocator::Allocator;
use oxc::codegen::Codegen;
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;
use oxc::transformer::{JsxOptions, JsxRuntime, TransformOptions, Transformer};
use sha2::{Digest, Sha256};

#[allow(dead_code)]
const HASH_LENGTH: usize = 16;
const LOCAL_EXTENSIONS: &[&str] = &[".tsx", ".ts", ".jsx", ".js", ".mjs"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModuleKind {
  Widget,
  Layout,
  Server,
}

impl ModuleKind {
  fn as_str(self) -> &'static str {
    match self {
      Self::Widget => "widget",
      Self::Layout => "layout",
      Self::Server => "server",
    }
  }
}

pub struct CompileOptions<'a> {
  pub kind: ModuleKind,
  pub extension_id: &'a str,
  pub extension_dir: &'a Path,
  pub entry_file: &'a Path,
  pub cache_root: &'a Path,
}

pub struct CompiledModule {
  pub hash: String,
  pub output_dir: PathBuf,
  pub output_path: PathBuf,
}

struct SourceModule {
  file_path: PathBuf,
  source: String,
}

pub fn compile_extension_module(options: CompileOptions<'_>) -> Result<CompiledModule, String> {
  let extension_dir = options.extension_dir.canonicalize().map_err(|e| e.to_string())?;
  let entry_file = options.entry_file.canonicalize().map_err(|e| e.to_string())?;
  assert_inside(&extension_dir, &entry_file, options.extension_id)?;

  let graph = collect_graph(options.kind, options.extension_id, &extension_dir, &entry_file)?;
  let hash = content_hash(options.kind, &extension_dir, &graph);
  let output_dir = options.cache_root.join(options.extension_id).join(&hash);
  fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;

  for module in &graph {
    let output_path = compiled_output_path(&output_dir, &extension_dir, &module.file_path);
    if let Some(parent) = output_path.parent() {
      fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let js = transpile(&module.file_path, &module.source)?;
    let rewritten = rewrite_imports(
      options.kind,
      options.extension_id,
      &extension_dir,
      &module.file_path,
      &js,
    )?;
    fs::write(&output_path, rewritten).map_err(|e| e.to_string())?;
  }

  let output_path = compiled_output_path(&output_dir, &extension_dir, &entry_file);
  Ok(CompiledModule {
    hash,
    output_dir,
    output_path,
  })
}

fn transpile(path: &Path, source: &str) -> Result<String, String> {
  let allocator = Allocator::default();
  let source_type = source_type_for(path);
  let parsed = Parser::new(&allocator, source, source_type).parse();
  if parsed.diagnostics.has_errors() {
    return Err(format!(
      "parse error in {}: {:?}",
      path.display(),
      parsed.diagnostics.first()
    ));
  }
  let mut program = parsed.program;
  let semantic = SemanticBuilder::new()
    .with_excess_capacity(2.0)
    .build(&program);
  let mut options = TransformOptions::default();
  options.jsx = JsxOptions {
    runtime: JsxRuntime::Automatic,
    ..JsxOptions::default()
  };
  let transformer = Transformer::new(&allocator, path, &options);
  let ret = transformer.build_with_scoping(semantic.semantic.into_scoping(), &mut program);
  if ret.diagnostics.has_errors() {
    return Err(format!(
      "transform error in {}: {:?}",
      path.display(),
      ret.diagnostics.first()
    ));
  }
  Ok(Codegen::new().build(&program).code)
}

fn source_type_for(path: &Path) -> SourceType {
  match path.extension().and_then(|e| e.to_str()) {
    Some("tsx") => SourceType::tsx(),
    Some("jsx") => SourceType::jsx(),
    Some("ts") => SourceType::ts(),
    _ => SourceType::mjs(),
  }
}

fn collect_graph(
  kind: ModuleKind,
  extension_id: &str,
  extension_dir: &Path,
  entry_file: &Path,
) -> Result<Vec<SourceModule>, String> {
  let mut modules = Vec::new();
  let mut pending = vec![entry_file.to_path_buf()];
  let mut seen = std::collections::HashSet::new();
  while let Some(file_path) = pending.pop() {
    if !seen.insert(file_path.clone()) {
      continue;
    }
    assert_inside(extension_dir, &file_path, extension_id)?;
    let source = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    for (specifier, _, _) in import_specifiers(&source, false) {
      if is_local(&specifier) {
        pending.push(resolve_local(&file_path, &specifier, extension_dir, extension_id)?);
      } else {
        assert_supported_external(kind, &specifier, extension_id, &file_path)?;
      }
    }
    modules.push(SourceModule { file_path, source });
  }
  modules.sort_by(|a, b| a.file_path.cmp(&b.file_path));
  Ok(modules)
}

fn rewrite_imports(
  kind: ModuleKind,
  extension_id: &str,
  extension_dir: &Path,
  file_path: &Path,
  source: &str,
) -> Result<String, String> {
  let mut out = source.to_string();
  let specifiers = import_specifiers(source, true);
  for specifier in specifiers.into_iter().rev() {
    let rewritten = rewrite_specifier(kind, extension_id, extension_dir, file_path, &specifier.0)?;
    if rewritten != specifier.0 {
      out.replace_range(specifier.1..specifier.2, &rewritten);
    }
  }
  Ok(out)
}

fn rewrite_specifier(
  kind: ModuleKind,
  extension_id: &str,
  extension_dir: &Path,
  file_path: &Path,
  specifier: &str,
) -> Result<String, String> {
  if !is_local(specifier) {
    return match specifier {
      "react" => Ok("/__host__/react/index.mjs".into()),
      "react/jsx-runtime" | "react/jsx-dev-runtime" => Ok("/__host__/react-jsx-runtime/index.mjs".into()),
      "@hatch/ui" => Ok("/__host__/ui/index.mjs".into()),
      other => {
        assert_supported_external(kind, other, extension_id, file_path)?;
        Ok(other.to_string())
      }
    };
  }
  let resolved = resolve_local(file_path, specifier, extension_dir, extension_id)?;
  Ok(relative_module_specifier(file_path, &resolved, extension_dir))
}

fn assert_supported_external(
  kind: ModuleKind,
  specifier: &str,
  extension_id: &str,
  file_path: &Path,
) -> Result<(), String> {
  let allowed_widget = matches!(
    specifier,
    "react" | "react/jsx-runtime" | "react/jsx-dev-runtime" | "@hatch/ui"
  );
  if matches!(kind, ModuleKind::Widget | ModuleKind::Layout) && allowed_widget {
    return Ok(());
  }
  if kind == ModuleKind::Server && (specifier.starts_with("node:") || specifier == "@hatch/contracts") {
    return Ok(());
  }
  if specifier == "@hatch/contracts" {
    return Ok(());
  }
  Err(format!(
    "Unsupported {} import \"{}\" in {} ({})",
    kind.as_str(),
    specifier,
    extension_id,
    file_path.display()
  ))
}

fn resolve_local(
  file_path: &Path,
  specifier: &str,
  extension_dir: &Path,
  extension_id: &str,
) -> Result<PathBuf, String> {
  let parent = file_path.parent().ok_or("missing parent")?;
  let base = parent.join(specifier);
  let candidates: Vec<PathBuf> = if base.extension().is_some() {
    vec![base]
  } else {
    LOCAL_EXTENSIONS
      .iter()
      .flat_map(|ext| {
        [
          PathBuf::from(format!("{}{ext}", base.display())),
          base.join(format!("index{ext}")),
        ]
      })
      .collect()
  };
  for candidate in candidates {
    if candidate.is_file() {
      let resolved = candidate.canonicalize().map_err(|e| e.to_string())?;
      assert_inside(extension_dir, &resolved, extension_id)?;
      return Ok(resolved);
    }
  }
  Err(format!(
    "Cannot resolve local import \"{}\" in {} ({})",
    specifier,
    extension_id,
    file_path.display()
  ))
}

fn compiled_output_path(output_dir: &Path, extension_dir: &Path, file_path: &Path) -> PathBuf {
  let relative = file_path.strip_prefix(extension_dir).unwrap_or(file_path);
  let mut out = output_dir.join(relative);
  out.set_extension("mjs");
  out
}

fn relative_module_specifier(from_file: &Path, to_file: &Path, extension_dir: &Path) -> String {
  let from_out = compiled_output_path(Path::new(""), extension_dir, from_file);
  let to_out = compiled_output_path(Path::new(""), extension_dir, to_file);
  let from_dir = from_out.parent().unwrap_or(Path::new(""));
  let mut specifier = pathdiff_posix(from_dir, &to_out);
  if !specifier.starts_with('.') {
    specifier = format!("./{specifier}");
  }
  specifier
}

fn pathdiff_posix(from_dir: &Path, to_file: &Path) -> String {
  let from: Vec<_> = from_dir.iter().collect();
  let to: Vec<_> = to_file.iter().collect();
  let mut i = 0;
  while i < from.len() && i < to.len() && from[i] == to[i] {
    i += 1;
  }
  let mut parts = Vec::new();
  for _ in i..from.len() {
    parts.push("..");
  }
  for part in &to[i..] {
    parts.push(part.to_str().unwrap_or(""));
  }
  if parts.is_empty() {
    return ".".into();
  }
  parts.join("/")
}

fn content_hash(kind: ModuleKind, extension_dir: &Path, modules: &[SourceModule]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(kind.as_str().as_bytes());
  hasher.update([0]);
  for module in modules {
    let relative = module.file_path.strip_prefix(extension_dir).unwrap_or(&module.file_path);
    hasher.update(relative.to_string_lossy().as_bytes());
    hasher.update([0]);
    hasher.update(module.source.as_bytes());
    hasher.update([0]);
  }
  let digest = hasher.finalize();
  digest[..8].iter().map(|byte| format!("{byte:02x}")).collect()
}

fn import_specifiers(source: &str, include_type_only: bool) -> Vec<(String, usize, usize)> {
  let mut out = Vec::new();
  for (idx, _rest) in source.match_indices("from ") {
    let after = &source[idx + 5..];
    let trimmed = after.trim_start();
    let quote = trimmed.chars().next();
    if quote != Some('"') && quote != Some('\'') {
      continue;
    }
    let q = quote.unwrap();
    let skip = after.len() - trimmed.len() + 1;
    let start = idx + 5 + skip;
    if let Some(end_rel) = source[start..].find(q) {
      let specifier = &source[start..start + end_rel];
      let statement_start = source[..idx].rfind('\n').map(|i| i + 1).unwrap_or(0);
      let statement = &source[statement_start..start];
      if !include_type_only && is_type_only_import(statement) {
        continue;
      }
      out.push((specifier.to_string(), start, start + end_rel));
    }
  }
  out.sort_by_key(|item| item.1);
  out
}

fn is_type_only_import(statement: &str) -> bool {
  let trimmed = statement.trim_start();
  trimmed.starts_with("import type ") || trimmed.starts_with("export type ")
}

fn is_local(specifier: &str) -> bool {
  specifier.starts_with("./") || specifier.starts_with("../")
}

fn assert_inside(root: &Path, candidate: &Path, extension_id: &str) -> Result<(), String> {
  if candidate.starts_with(root) {
    return Ok(());
  }
  Err(format!(
    "Extension path escapes workspace: {extension_id} {}",
    candidate.display()
  ))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn compiles_tsx_widget_with_host_shims() {
    let dir = tempfile();
    let ext = dir.join("meter");
    fs::create_dir_all(&ext).unwrap();
    fs::write(ext.join("helper.ts"), "export const label: string = \"CPU\";\n").unwrap();
    fs::write(
      ext.join("widget.tsx"),
      r#"import { useState } from "react";
import { label } from "./helper";
export const widget = { id: "meter", title: label, render: () => <span>{useState(1)[0]}</span> };
"#,
    )
    .unwrap();
    let cache = dir.join("cache");
    let compiled = compile_extension_module(CompileOptions {
      kind: ModuleKind::Widget,
      extension_id: "meter",
      extension_dir: &ext,
      entry_file: &ext.join("widget.tsx"),
      cache_root: &cache,
    })
    .unwrap();
    assert_eq!(compiled.hash.len(), HASH_LENGTH);
    let output = fs::read_to_string(&compiled.output_path).unwrap();
    assert!(output.contains("/__host__/react/index.mjs"), "{output}");
    assert!(output.contains("/__host__/react-jsx-runtime/index.mjs"), "{output}");
    assert!(output.contains("./helper.mjs"), "{output}");
    let helper = fs::read_to_string(compiled.output_dir.join("helper.mjs")).unwrap();
    assert!(helper.contains("CPU"), "{helper}");
  }

  #[test]
  fn erases_type_only_contract_imports() {
    let dir = tempfile();
    let ext = dir.join("starter");
    fs::create_dir_all(&ext).unwrap();
    fs::write(
      ext.join("widget.tsx"),
      r#"import type { RefreshableHatchWidget } from "@hatch/contracts";
export const widget: RefreshableHatchWidget = { id: "starter", title: "Starter", render: () => "ok" };
"#,
    )
    .unwrap();
    let compiled = compile_extension_module(CompileOptions {
      kind: ModuleKind::Widget,
      extension_id: "starter",
      extension_dir: &ext,
      entry_file: &ext.join("widget.tsx"),
      cache_root: &dir.join("cache"),
    })
    .unwrap();
    let output = fs::read_to_string(compiled.output_path).unwrap();
    assert!(!output.contains("@hatch/contracts"), "{output}");
  }

  fn tempfile() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("hatch-compile-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let _ = std::io::stderr().lock();
    dir
  }
}
