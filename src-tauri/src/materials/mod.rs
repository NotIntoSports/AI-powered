pub mod backup;
pub mod chunk;
pub mod hybrid;
pub mod parse;
pub mod store;

pub use backup::{BackupError, BackupService};
pub use chunk::{CHUNKER_VERSION, MaterialChunk, chunk_text};
pub use hybrid::EmbeddingSpace;
pub use parse::{ParseError, extract_text, parser_version};
pub use store::{MaterialSearchHit, MaterialStore, NewMaterial};
