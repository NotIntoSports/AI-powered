use std::path::Path;

use crate::{
    database::{Database, DatabaseError},
    materials::{CHUNKER_VERSION, MaterialStore, NewMaterial, chunk_text, store::sha256_hex},
};

pub use crate::materials::MaterialSearchHit;

pub const PARSER_VERSION: &str = "utf8-plain-v1";
const MAX_MATERIAL_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterialSummary {
    pub id: String,
    pub file_name: String,
    pub content_sha256: String,
    pub media_type: String,
    pub byte_size: i64,
    pub status: String,
    pub chunk_count: i64,
}

#[derive(Debug)]
pub enum MaterialServiceError {
    TypeUnsupported,
    TooLarge,
    NotUtf8,
    NotFound,
    Operation,
}

impl MaterialServiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::TypeUnsupported => "MATERIAL_TYPE_UNSUPPORTED",
            Self::TooLarge => "MATERIAL_TOO_LARGE",
            Self::NotUtf8 => "MATERIAL_NOT_UTF8",
            Self::NotFound => "MATERIAL_NOT_FOUND",
            Self::Operation => "MATERIAL_OPERATION_FAILED",
        }
    }
}

impl From<DatabaseError> for MaterialServiceError {
    fn from(_: DatabaseError) -> Self {
        Self::Operation
    }
}

pub struct MaterialService<'a> {
    database: &'a Database,
    data_directory: &'a Path,
}

impl<'a> MaterialService<'a> {
    pub fn new(database: &'a Database, data_directory: &'a Path) -> Self {
        Self {
            database,
            data_directory,
        }
    }

    pub fn import_file(
        &self,
        source: impl AsRef<Path>,
    ) -> Result<MaterialSummary, MaterialServiceError> {
        let source = source.as_ref();
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let media_type = match extension.as_str() {
            "txt" => "text/plain",
            "md" => "text/markdown",
            _ => return Err(MaterialServiceError::TypeUnsupported),
        };
        let metadata = std::fs::metadata(source).map_err(|_| MaterialServiceError::Operation)?;
        if metadata.len() > MAX_MATERIAL_BYTES {
            return Err(MaterialServiceError::TooLarge);
        }
        let bytes = std::fs::read(source).map_err(|_| MaterialServiceError::Operation)?;
        if bytes.len() as u64 > MAX_MATERIAL_BYTES {
            return Err(MaterialServiceError::TooLarge);
        }
        let content_sha256 = sha256_hex(&bytes);
        let store = MaterialStore::new(self.database);
        if let Some(existing) = store.find_by_hash(&content_sha256)? {
            return Ok(summary(existing));
        }
        let text = String::from_utf8(bytes).map_err(|_| MaterialServiceError::NotUtf8)?;
        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or(MaterialServiceError::Operation)?;
        let label = source
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or(file_name);
        let chunks = chunk_text(label, &text);
        let id = uuid::Uuid::new_v4().to_string();
        let stored_path = format!("materials/{id}.{extension}");
        let destination = self.data_directory.join(&stored_path);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|_| MaterialServiceError::Operation)?;
        }
        std::fs::write(&destination, text.as_bytes())
            .map_err(|_| MaterialServiceError::Operation)?;
        let insert = store.insert_text_ready(NewMaterial {
            id: &id,
            file_name,
            stored_path: &stored_path,
            content_sha256: &content_sha256,
            media_type,
            byte_size: text.len() as i64,
            parser_version: PARSER_VERSION,
            chunker_version: CHUNKER_VERSION,
            extracted_text: &text,
            chunks: &chunks,
        });
        if insert.is_err() {
            let _ = std::fs::remove_file(&destination);
            insert?;
        }
        store
            .get(&id)?
            .map(summary)
            .ok_or(MaterialServiceError::Operation)
    }

    pub fn delete(&self, id: &str) -> Result<(), MaterialServiceError> {
        let store = MaterialStore::new(self.database);
        let stored_path = store
            .block_retrieval(id)?
            .ok_or(MaterialServiceError::NotFound)?;
        store.delete_indexed_rows(id)?;
        let destination = self.data_directory.join(&stored_path);
        if destination.exists() && std::fs::remove_file(&destination).is_err() {
            store.enqueue_cleanup(&stored_path, "MATERIAL_FILE_DELETE_FAILED")?;
        }
        Ok(())
    }

    pub fn search_text(
        &self,
        query: &str,
        top_k: Option<u32>,
    ) -> Result<Vec<MaterialSearchHit>, MaterialServiceError> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        Ok(MaterialStore::new(self.database).search_text(query, top_k.unwrap_or(20))?)
    }
}

fn summary(record: crate::materials::store::MaterialRecord) -> MaterialSummary {
    MaterialSummary {
        id: record.id,
        file_name: record.file_name,
        content_sha256: record.content_sha256,
        media_type: record.media_type,
        byte_size: record.byte_size,
        status: record.status,
        chunk_count: record.chunk_count,
    }
}

#[cfg(test)]
mod tests {
    use super::MaterialService;
    use crate::{database::Database, materials::MaterialStore};

    fn opened(directory: &tempfile::TempDir) -> Database {
        let database = Database::open(directory.path().join("app.sqlite3")).unwrap();
        database.migrate().unwrap();
        database
    }

    #[test]
    fn import_indexes_utf8_text_and_deduplicates_by_hash() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("resume.md");
        std::fs::write(
            &source,
            "工作经历\n2019.03-2021.06 阿里巴巴 高级工程师\n负责订单服务与 Kafka 链路。",
        )
        .unwrap();
        let database = opened(&directory);
        let service = MaterialService::new(&database, directory.path());

        let first = service.import_file(&source).unwrap();
        assert_eq!(first.file_name, "resume.md");
        assert_eq!(first.media_type, "text/markdown");
        assert_eq!(first.status, "text_ready");
        assert!(first.chunk_count >= 1);
        assert!(
            directory
                .path()
                .join("materials")
                .join(format!("{}.md", first.id))
                .exists()
        );
        assert_eq!(
            MaterialStore::new(&database)
                .searchable_chunk_count("订单服务")
                .unwrap(),
            1
        );

        let second = service.import_file(&source).unwrap();
        assert_eq!(second.id, first.id);
        assert_eq!(
            std::fs::read_dir(directory.path().join("materials"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn import_rejects_oversize_and_unsupported_types() {
        let directory = tempfile::tempdir().unwrap();
        let database = opened(&directory);
        let service = MaterialService::new(&database, directory.path());
        let pdf = directory.path().join("scan.pdf");
        std::fs::write(&pdf, b"%PDF").unwrap();
        assert_eq!(
            service.import_file(&pdf).unwrap_err().code(),
            "MATERIAL_TYPE_UNSUPPORTED"
        );

        let huge = directory.path().join("huge.txt");
        std::fs::write(&huge, vec![b'a'; (8 * 1024 * 1024) + 1]).unwrap();
        assert_eq!(
            service.import_file(&huge).unwrap_err().code(),
            "MATERIAL_TOO_LARGE"
        );

        let binary = directory.path().join("notes.txt");
        std::fs::write(&binary, [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(
            service.import_file(&binary).unwrap_err().code(),
            "MATERIAL_NOT_UTF8"
        );
    }

    #[test]
    fn delete_removes_index_and_queues_file_when_unlink_fails() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("note.txt");
        std::fs::write(&source, "第一段公司经历内容。\n\n第二段项目经历内容。").unwrap();
        let database = opened(&directory);
        let service = MaterialService::new(&database, directory.path());
        let imported = service.import_file(&source).unwrap();
        service.delete(&imported.id).unwrap();
        assert!(
            MaterialStore::new(&database)
                .get(&imported.id)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            MaterialStore::new(&database)
                .searchable_chunk_count("公司经历")
                .unwrap(),
            0
        );
        assert!(
            !directory
                .path()
                .join("materials")
                .join(format!("{}.txt", imported.id))
                .exists()
        );

        let again = directory.path().join("keep.txt");
        std::fs::write(&again, "负责订单服务与 Kafka 链路，完整句子用于检索。").unwrap();
        let kept = service.import_file(&again).unwrap();
        let stored = directory
            .path()
            .join("materials")
            .join(format!("{}.txt", kept.id));
        std::fs::remove_file(&stored).unwrap();
        std::fs::create_dir(&stored).unwrap();
        std::fs::write(stored.join("locked"), "x").unwrap();
        service.delete(&kept.id).unwrap();
        assert_eq!(
            MaterialStore::new(&database).cleanup_paths().unwrap(),
            vec![format!("materials/{}.txt", kept.id)]
        );
    }

    #[test]
    fn delete_missing_material_fails_closed() {
        let directory = tempfile::tempdir().unwrap();
        let database = opened(&directory);
        let service = MaterialService::new(&database, directory.path());
        assert_eq!(
            service.delete("missing").unwrap_err().code(),
            "MATERIAL_NOT_FOUND"
        );
    }

    #[test]
    fn search_text_matches_chinese_and_keeps_vector_ready() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("resume.md");
        std::fs::write(
            &source,
            "工作经历\n2019.03-2021.06 阿里巴巴 高级工程师\n负责订单服务与 Kafka 链路。",
        )
        .unwrap();
        let database = opened(&directory);
        let service = MaterialService::new(&database, directory.path());
        let imported = service.import_file(&source).unwrap();

        let hits = service.search_text("订单服务", None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].material_id, imported.id);
        assert_eq!(hits[0].chunk_id, format!("{}:0", imported.id));
        assert_eq!(hits[0].file_name, "resume.md");
        assert_eq!(hits[0].section, "工作经历");
        assert!(hits[0].snippet.contains("订单服务"));
        assert!(hits[0].snippet.chars().count() <= 160);
        assert!(hits[0].rank.is_finite());

        database
            .with_connection(|connection| {
                connection.execute(
                    "UPDATE materials SET status = 'vector_ready' WHERE id = ?1",
                    rusqlite::params![imported.id],
                )
            })
            .unwrap();
        assert_eq!(service.search_text("订单服务", None).unwrap().len(), 1);
    }

    #[test]
    fn search_text_skips_blocked_and_non_ready_materials() {
        let directory = tempfile::tempdir().unwrap();
        let database = opened(&directory);
        let service = MaterialService::new(&database, directory.path());

        let blocked_source = directory.path().join("blocked.md");
        std::fs::write(
            &blocked_source,
            "负责订单服务与 Kafka 链路，完整句子用于检索。",
        )
        .unwrap();
        let blocked = service.import_file(&blocked_source).unwrap();
        MaterialStore::new(&database)
            .block_retrieval(&blocked.id)
            .unwrap();

        let failed_source = directory.path().join("failed.md");
        std::fs::write(&failed_source, "另一份订单服务说明，用于失败状态过滤。").unwrap();
        let failed = service.import_file(&failed_source).unwrap();
        database
            .with_connection(|connection| {
                connection.execute(
                    "UPDATE materials SET status = 'failed' WHERE id = ?1",
                    rusqlite::params![failed.id],
                )
            })
            .unwrap();

        assert!(service.search_text("订单服务", None).unwrap().is_empty());
    }

    #[test]
    fn search_text_empty_query_returns_no_hits() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("note.txt");
        std::fs::write(&source, "负责订单服务与 Kafka 链路，完整句子用于检索。").unwrap();
        let database = opened(&directory);
        let service = MaterialService::new(&database, directory.path());
        service.import_file(&source).unwrap();

        assert!(service.search_text("", None).unwrap().is_empty());
        assert!(service.search_text("   \t\n", Some(20)).unwrap().is_empty());
    }

    #[test]
    fn search_text_short_query_likes_content_and_clamps_top_k() {
        let directory = tempfile::tempdir().unwrap();
        let database = opened(&directory);
        let service = MaterialService::new(&database, directory.path());

        let first = directory.path().join("one.txt");
        std::fs::write(&first, "订单服务第一份材料，包含 100% 完成_验收。").unwrap();
        let second = directory.path().join("two.txt");
        std::fs::write(&second, "订单服务第二份材料，同样可被短词检索。").unwrap();
        service.import_file(&first).unwrap();
        service.import_file(&second).unwrap();

        let short = service.search_text("订单", None).unwrap();
        assert_eq!(short.len(), 2);
        assert!(short.iter().all(|hit| hit.rank == 0.0));
        assert!(short.iter().all(|hit| hit.snippet.contains("订单")));

        let limited = service.search_text("订单", Some(1)).unwrap();
        assert_eq!(limited.len(), 1);

        let clamped = service.search_text("订单服务", Some(0)).unwrap();
        assert_eq!(clamped.len(), 1);

        let escaped = service.search_text("%", None).unwrap();
        assert_eq!(escaped.len(), 1);
        assert!(escaped[0].snippet.contains("100%"));
    }
}
