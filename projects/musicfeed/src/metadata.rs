// src/metadata.rs

//! Album metadata lookups via [MusicBrainz] and the [Cover Art Archive].
//!
//! Borrowed from the `OpenRouterClient` in the user's `flux-learner` repo, which
//! already does this kind of external lookup. The part kept is `new(..)`
//! delegating to `with_base_url(..)`: the production URL is a constructor
//! argument, so a test can point the client at a local stub instead of the
//! internet. No trait, no generics, no mocking framework needed.
//!
//! [MusicBrainz]: https://musicbrainz.org/doc/MusicBrainz_API
//! [Cover Art Archive]: https://coverartarchive.org

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::time::Duration;

use crate::domain::RotationEntry;

const MUSICBRAINZ_BASE_URL: &str = "https://musicbrainz.org/ws/2";
const COVER_ART_BASE_URL: &str = "https://coverartarchive.org";

/// MusicBrainz requires a User-Agent identifying the application, and returns
/// **HTTP 403** without one. Their spec asks for `app/version ( contact )`, so
/// the contact is part of the constant rather than an afterthought.
const USER_AGENT: &str = "musicfeed/0.2.0 ( https://github.com/crustyrustacean/ZTM-Build-Fest )";

/// MusicBrainz allows roughly one request per second. Being a well-behaved
/// caller is a requirement, not a nicety: exceeding it earns a 503.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// What a lookup is asking about — only what the user typed. Supplying the
/// cover and the year is the whole point of asking.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AlbumQuery {
    pub artist: String,
    pub album: String,
}

impl AlbumQuery {
    pub fn new(artist: impl Into<String>, album: impl Into<String>) -> Self {
        Self {
            artist: artist.into(),
            album: album.into(),
        }
    }
}

impl From<&RotationEntry> for AlbumQuery {
    fn from(entry: &RotationEntry) -> Self {
        Self::new(entry.artist.clone(), entry.album.clone())
    }
}

/// A lookup found nothing. This is an ordinary outcome, not a failure: the
/// entry is still worth saving, just without a cover or a year.
pub const NOT_FOUND: AlbumMetadata = AlbumMetadata {
    cover: None,
    year: None,
};

/// What a successful lookup produces.
///
/// Both fields are optional. `0` is not a year and `""` is not a cover, which
/// is exactly why neither is a bare value here.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct AlbumMetadata {
    pub cover: Option<String>,
    pub year: Option<i32>,
}

/// A lookup failed in a way that means "we do not know", not "no album exists".
#[derive(thiserror::Error, Debug)]
pub enum MetadataError {
    #[error("metadata request failed")]
    Request(#[from] reqwest::Error),

    #[error("metadata service returned status {status}")]
    Status { status: u16 },

    #[error("could not read metadata response")]
    Decode,
}

// ---------------------------------------------------------------------------
// MusicBrainz response shapes
// Captured from live responses, not from documentation guesses. Fields that are
// never read are omitted; serde ignores the rest of the document.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ReleaseSearchResponse {
    releases: Vec<Release>,
}

#[derive(Clone, Debug, Deserialize)]
struct Release {
    id: String,
    /// Kept for tests and debugging. The selected title is never shown to the
    /// user — they typed it — but it is what tests assert on to confirm the
    /// right release was chosen out of several matches.
    #[allow(dead_code)]
    title: String,
    /// Full ISO date, e.g. `"2006-07-28"`. May be partial (`"2000"`), may be
    /// an EMPTY STRING, or may be absent entirely. MusicBrainz uses all three:
    /// Judas Priest's Invincible Shield comes back with `"date": ""` on one of
    /// eleven score-100 results. An empty string is not a date, so
    /// [`parse_year`] treats it as unknown.
    date: Option<String>,
    /// Search relevance, 0-100. An exact match scores 100; reissues score lower.
    score: i32,
    #[serde(rename = "release-group")]
    release_group: ReleaseGroup,
}

#[derive(Clone, Debug, Deserialize)]
struct ReleaseGroup {
    #[serde(rename = "primary-type")]
    primary_type: Option<String>,
}

// ---------------------------------------------------------------------------
// Cover Art Archive response shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CoverArtResponse {
    #[serde(default)]
    images: Vec<CoverImage>,
}

#[derive(Debug, Deserialize)]
struct CoverImage {
    /// Distinguishes the front cover from back, booklets, and medium discs.
    front: bool,
    thumbnails: Thumbnails,
}

#[derive(Debug, Deserialize)]
struct Thumbnails {
    #[serde(rename = "250", default)]
    small: Option<String>,
    #[serde(rename = "500", default)]
    medium: Option<String>,
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/// A client for MusicBrainz and the Cover Art Archive.
///
/// Holds its base URLs so both services can be substituted in a test. Cheap to
/// clone and holds no global state.
#[derive(Clone, Debug)]
pub struct MetadataClient {
    http: reqwest::Client,
    musicbrainz_base_url: String,
    cover_art_base_url: String,
}

impl MetadataClient {
    /// A client pointed at the real services.
    pub fn new() -> Self {
        Self::with_base_urls(
            MUSICBRAINZ_BASE_URL.to_string(),
            COVER_ART_BASE_URL.to_string(),
        )
    }

    /// A client pointed at arbitrary base URLs — the seam a test uses to stub
    /// both services without touching the network.
    pub fn with_base_urls(musicbrainz_base_url: String, cover_art_base_url: String) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .user_agent(USER_AGENT)
                .build()
                .expect("failed to build the metadata HTTP client"),
            musicbrainz_base_url,
            cover_art_base_url,
        }
    }

    pub fn musicbrainz_base_url(&self) -> &str {
        &self.musicbrainz_base_url
    }

    pub fn cover_art_base_url(&self) -> &str {
        &self.cover_art_base_url
    }

    /// Look up, and never fail.
    ///
    /// A lookup that errors — the service is down, we are being rate-limited,
    /// the request timed out — must never block the save. Losing an entry
    /// because someone else's server was briefly unreachable is the wrong
    /// trade, so the entry goes in bare and the caller is told why.
    ///
    /// Returns `NOT_FOUND` for both a genuine miss and an error, so the caller
    /// cannot tell them apart from the value alone. That is deliberate: the
    /// decision to surface the difference belongs to the handler, not here.
    pub async fn lookup_best_effort(&self, query: &AlbumQuery) -> AlbumMetadata {
        match self.lookup(query).await {
            Ok(metadata) => metadata,
            Err(error) => {
                tracing::warn!(
                    artist = %query.artist,
                    album = %query.album,
                    error = %error,
                    "metadata lookup failed; saving the entry without a cover or year"
                );
                NOT_FOUND
            }
        }
    }

    /// Look up a release and return whatever cover and year can be found.
    ///
    /// A miss yields [`NOT_FOUND`] rather than an error, so a caller can always
    /// save the entry. Only a genuine failure — network, bad status, unparseable
    /// body — produces an `Err`.
    pub async fn lookup(&self, query: &AlbumQuery) -> Result<AlbumMetadata, MetadataError> {
        let Some(releases) = self.find_releases(query).await? else {
            return Ok(NOT_FOUND);
        };

        // Walk the ranked candidates until one yields an image.
        //
        // Ranking alone is not enough to pick a winner: Judas Priest's *Invincible
        // Shield* returns ten score-100 releases, two of which share the earliest
        // date. One has art; the other 404s. Deciding by date alone picks whichever
        // happened to sort last, so whether a cover exists has to be part of the
        // decision rather than a consequence of it.
        //
        // Candidates arrive best-first, so the first with a cover is the best one
        // that actually has one. If none do, the earliest year still survives.
        let mut first_with_year = None;

        for release in releases {
            let year = release_year(&release);

            match (year, self.find_cover(&release.id).await) {
                // Best case: this release has both. Take it and stop.
                (Some(year), Ok(Some(cover))) => {
                    return Ok(AlbumMetadata {
                        cover: Some(cover),
                        year: Some(year),
                    });
                }
                // A cover beats a year, so keep looking - but hold this year in case
                // no later candidate offers an image.
                (Some(year), _) => {
                    if first_with_year.is_none() {
                        first_with_year = Some(year);
                    }
                }
                (None, Ok(Some(cover))) => {
                    return Ok(AlbumMetadata {
                        cover: Some(cover),
                        year: None,
                    });
                }
                (None, _) => {}
            }
        }

        Ok(AlbumMetadata {
            cover: None,
            year: first_with_year,
        })
    }

    /// Search for releases matching an artist and title.
    ///
    /// Returns candidates **ordered best-first**, not a single winner — see
    /// [`Self::lookup`] for why the caller needs to see more than one.
    ///
    /// Returns `None` when nothing matches. The query is quoted because album
    /// titles contain characters Lucene would otherwise read as operators.
    async fn find_releases(
        &self,
        query: &AlbumQuery,
    ) -> Result<Option<Vec<Release>>, MetadataError> {
        let search = format!(
            r#"release:"{}" AND artist:"{}""#,
            escape_lucene(&query.album),
            escape_lucene(&query.artist)
        );

        let url = format!(
            "{}/release/?query={}&fmt=json&limit=10",
            self.musicbrainz_base_url,
            encode(&search)
        );

        let response: ReleaseSearchResponse = self.get_json(&url).await?;
        Ok(rank_releases(response.releases))
    }

    /// Fetch cover art for a MusicBrainz release ID.
    ///
    /// Returns `Ok(None)` when the archive has no art for that release, which
    /// is common for bootlegs and compilations. A **404 means exactly that** —
    /// the archive does not serve a 404 for a release that exists — so it is
    /// treated as a miss, not a failure. Otherwise one album with no art would
    /// discard the year we already resolved.
    async fn find_cover(&self, release_id: &str) -> Result<Option<String>, MetadataError> {
        let url = format!("{}/release/{release_id}", self.cover_art_base_url);

        let response = match self.get_json_opt::<CoverArtResponse>(&url).await? {
            Some(response) => response,
            None => return Ok(None),
        };

        Ok(response
            .images
            .into_iter()
            .find(|image| image.front)
            // 250px suits the blog's card layout; fall back to 500 for the
            // rare release that only has larger art.
            .and_then(|image| image.thumbnails.small.or(image.thumbnails.medium))
            .map(|url| to_https(&url)))
    }

    /// GET a JSON document, treating 404 as "absent" rather than "failed".
    ///
    /// Used where a missing resource is an ordinary outcome. A 404 from the
    /// Cover Art Archive means it has no art for that release, which is not an
    /// error worth losing an otherwise-good lookup over.
    async fn get_json_opt<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
    ) -> Result<Option<T>, MetadataError> {
        let response = self.http.get(url).send().await?;

        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(MetadataError::Status {
                status: status.as_u16(),
            });
        }

        response
            .json::<T>()
            .await
            .map(Some)
            .map_err(|_| MetadataError::Decode)
    }

    async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
    ) -> Result<T, MetadataError> {
        let response = self.http.get(url).send().await?;

        let status = response.status();
        if !status.is_success() {
            return Err(MetadataError::Status {
                status: status.as_u16(),
            });
        }

        response
            .json::<T>()
            .await
            .map_err(|_| MetadataError::Decode)
    }
}

impl Default for MetadataClient {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Selecting the right release
// ---------------------------------------------------------------------------

/// Choose which of several matches to use.
///
/// A search for "Attero Dominatus" by Sabaton returns seven results, and the
/// second is *"Attero Dominatus (Re-Armed)"* — a 2015 Japanese reissue. Taking
/// `releases[0]` is right sometimes and wrong other times, so rank instead:
///
/// 1. Prefer `primary-type == "Album"`, dropping Singles and EPs.
/// 2. Within that, prefer the highest search score — an exact title match beats
///    a near match.
/// 3. Keep the earliest date, so the original release wins over reissues.
fn rank_releases(releases: Vec<Release>) -> Option<Vec<Release>> {
    // Prefer albums, but if every match was a Single or EP, fall back to the
    // whole set rather than reporting nothing. Better to offer a slightly
    // wrong-shaped answer than none at all — the caller treats a miss as
    // "no cover, no year" and saves the entry regardless.
    let albums: Vec<Release> = releases
        .iter()
        .filter(|release| {
            release
                .release_group
                .primary_type
                .as_deref()
                .is_none_or(|kind| kind == "Album")
        })
        .cloned()
        .collect();

    let pool = if albums.is_empty() { releases } else { albums };

    // Highest score wins. Ties go to the earliest dated release, so the original
    // beats a reissue of the same album. A release with no date sorts last, because
    // it can supply neither a year nor, in practice, cover art.
    let mut ranked = pool;
    ranked.sort_by(|a, b| {
        b.score.cmp(&a.score).then_with(|| {
            match (release_year_key(&a.date), release_year_key(&b.date)) {
                // Both dated: earliest first, so the original beats a reissue.
                (Some(a_year), Some(b_year)) => a_year.cmp(&b_year),
                // A dated release outranks one with no date at all.
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (None, None) => Ordering::Equal,
            }
        })
    });

    (!ranked.is_empty()).then_some(ranked)
}

/// Year from a release date such as `"2006-07-28"` or `"2006"`.
///
/// Returns `None` rather than guessing when the date is absent or malformed.
fn release_year(release: &Release) -> Option<i32> {
    release.date.as_deref().and_then(parse_year)
}

fn parse_year(date: &str) -> Option<i32> {
    // An empty string is not a year. `Option<String>` only covers a *missing*
    // key, so `"date": ""` would otherwise sail through as a "dated" release
    // and win the ranking tiebreak — while contributing no year at all.
    let date = date.trim();
    if date.is_empty() {
        return None;
    }
    let head = date.split(['-', 'T']).next()?;
    head.parse().ok()
}

/// Sortable key for ranking releases by age.
///
/// A release with **no usable date loses** to any release that has one. MusicBrainz
/// returns dateless records for plenty of real albums — Judas Priest's *Invincible
/// Shield* returns one at score 100 alongside nine dated editions, and picking it
/// means no year *and* an MBID with no cover art. Unknown age is genuinely worse
/// than known age, so it must rank last.
fn release_year_key(date: &Option<String>) -> Option<i32> {
    date.as_deref().and_then(parse_year)
}

/// Escape a user-typed string for use inside a quoted Lucene query.
///
/// Quotes inside the value would otherwise terminate the clause early and
/// change the meaning of the query — an album titled `Love "Live"` would
/// otherwise be searched as something else entirely.
fn escape_lucene(value: &str) -> String {
    value.replace('\\', r"\\").replace('"', "\\\"")
}

/// Percent-encode a query string component.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The Cover Art Archive returns `http://` URLs. Serving the page over HTTPS
/// and loading an image over HTTP would be blocked as mixed content.
fn to_https(url: &str) -> String {
    url.replacen("http://", "https://", 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(title: &str, date: Option<&str>, score: i32, primary_type: Option<&str>) -> Release {
        Release {
            id: format!("id-{title}"),
            title: title.to_string(),
            date: date.map(str::to_string),
            score,

            release_group: ReleaseGroup {
                primary_type: primary_type.map(str::to_string),
            },
        }
    }

    #[test]
    fn parses_a_full_iso_date_into_a_year() {
        // Captured from the real API for Sabaton's Attero Dominatus.
        let release = release("Attero Dominatus", Some("2006-07-28"), 100, Some("Album"));
        assert_eq!(release_year(&release), Some(2006));
    }

    #[test]
    fn parses_a_partial_date() {
        let release = release("Cocoon", Some("2020"), 100, Some("Album"));
        assert_eq!(release_year(&release), Some(2020));
    }

    #[test]
    fn a_missing_date_is_not_the_year_zero() {
        // The bug that started this: a blank year must never become `0`.
        let release = release("Unknown", None, 100, Some("Album"));
        assert_eq!(release_year(&release), None);
    }

    #[test]
    fn a_malformed_date_is_not_the_year_zero() {
        let release = release("Weird", Some("circa 2006"), 100, Some("Album"));
        assert_eq!(release_year(&release), None);
    }

    #[test]
    fn prefers_the_album_over_a_reissue() {
        // The real search for this returned seven results; #2 was
        // "Attero Dominatus (Re-Armed)", a 2015 reissue.
        let ranked = rank_releases(vec![
            release(
                "Attero Dominatus (Re-Armed)",
                Some("2015-12-23"),
                84,
                Some("Album"),
            ),
            release("Attero Dominatus", Some("2006-07-28"), 100, Some("Album")),
        ]);
        let first = ranked.expect("albums ranked").remove(0);
        assert_eq!(first.title, "Attero Dominatus");
        assert_eq!(release_year(&first), Some(2006));
    }

    #[test]
    fn drops_singles_and_eps() {
        let ranked = rank_releases(vec![
            release("Cocoon", Some("2020-01-01"), 100, Some("Single")),
            release(
                "Curse of the Crystal Coconut",
                Some("2020-05-29"),
                90,
                Some("Album"),
            ),
        ]);
        let first = ranked.expect("albums ranked").remove(0);
        assert_eq!(first.title, "Curse of the Crystal Coconut");
    }

    #[test]
    fn keeps_an_untyped_release_rather_than_reporting_nothing() {
        // Some releases carry no primary-type. Better to offer them than nothing.
        let ranked = rank_releases(vec![release("Obscure", Some("2001"), 70, None)]);
        assert!(ranked.is_some_and(|r| !r.is_empty()));
    }

    #[test]
    fn a_dateless_release_loses_to_one_with_a_date() {
        // The real search for Judas Priest's Invincible Shield returns eleven
        // results, all scoring 100. The top one has NO date, and its MBID has no
        // cover art — so ranking it first cost us both the year and the image.
        let ranked = rank_releases(vec![
            release("Invincible Shield", None, 100, Some("Album")),
            release("Invincible Shield", Some("2024-03-08"), 100, Some("Album")),
            release("Invincible Shield", Some("2024-03-06"), 100, Some("Album")),
        ]);
        let first = ranked.expect("albums ranked").remove(0);
        assert_eq!(
            release_year(&first),
            Some(2024),
            "a dateless release should never outrank a dated one"
        );
    }

    #[test]
    fn a_dateless_release_is_still_usable_when_it_is_all_there_is() {
        // Nothing to compare against, so it must not be discarded — a year of
        // `None` is better than reporting nothing at all.
        let ranked = rank_releases(vec![release("Obscure", None, 100, Some("Album"))]);
        assert!(ranked.is_some_and(|r| !r.is_empty()));
    }

    #[test]
    fn an_empty_date_string_counts_as_no_date() {
        // MusicBrainz returns `"date": ""`, not a missing key, for some real
        // releases. `Option<String>` covers the missing case only, so without
        // this the dateless record still won the ranking and lost the cover.
        let blank = release("Invincible Shield", Some(""), 100, Some("Album"));
        assert_eq!(release_year(&blank), None);

        let ranked = rank_releases(vec![
            release("Invincible Shield", Some(""), 100, Some("Album")),
            release("Invincible Shield", Some("2024-03-08"), 100, Some("Album")),
        ]);
        assert_eq!(
            release_year(&ranked.expect("albums ranked").remove(0)),
            Some(2024),
            "an empty date string should not outrank a real one"
        );
    }

    #[test]
    fn quotes_in_a_title_cannot_break_out_of_the_query() {
        assert_eq!(escape_lucene(r#"Love "Live""#), r#"Love \"Live\""#);
    }

    #[test]
    fn query_characters_are_percent_encoded() {
        assert_eq!(encode("Attero Dominatus"), "Attero%20Dominatus");
        assert_eq!(encode("a\"b"), "a%22b");
    }

    #[test]
    fn cover_urls_are_upgraded_to_https() {
        // The archive returns http://, which a page served over https would
        // refuse to load as mixed content.
        assert_eq!(
            to_https("http://coverartarchive.org/release/abc/1.jpg"),
            "https://coverartarchive.org/release/abc/1.jpg"
        );
    }

    #[test]
    fn picks_the_front_cover_when_several_images_are_offered() {
        // Real responses include back covers and booklet scans alongside.
        let response: CoverArtResponse = serde_json::from_str(
            r#"{"images":[
                {"front":false,"thumbnails":{"250":"http://x/back.jpg"}},
                {"front":true,"thumbnails":{"250":"http://x/front.jpg"}}
            ]}"#,
        )
        .unwrap();
        let front = response
            .images
            .into_iter()
            .find(|image| image.front)
            .and_then(|image| image.thumbnails.small)
            .map(|url| to_https(&url));
        assert_eq!(front.as_deref(), Some("https://x/front.jpg"));
    }

    #[test]
    fn a_release_with_no_art_yields_no_cover() {
        let response: CoverArtResponse = serde_json::from_str(r#"{"images":[]}"#).unwrap();
        assert!(response.images.is_empty());
    }

    #[test]
    fn deserialises_the_shape_musicbrainz_actually_returns() {
        // Trimmed from a live response, including the hyphenated keys.
        let json = r#"{"created":"2026-10-04T04:15:31.833Z","count":7,"offset":0,
            "releases":[{
              "id":"b4974b0b-305e-4f98-b16d-04112f3cced2",
              "score":100,"status":"Official",
              "title":"Attero Dominatus",
              "artist-credit":[{"name":"Sabaton","artist":{"id":"39a3","name":"Sabaton"}}],
              "release-group":{"id":"9ca8","type-id":"f529","primary-type":"Album",
                                "title":"Attero Dominatus","primary-type-id":"f529"},
              "date":"2006-07-28","country":"SE","track-count":9
            }]}"#;
        let parsed: ReleaseSearchResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.releases.len(), 1);
        assert_eq!(parsed.releases[0].title, "Attero Dominatus");
        assert_eq!(release_year(&parsed.releases[0]), Some(2006));
        assert_eq!(
            parsed.releases[0].release_group.primary_type.as_deref(),
            Some("Album")
        );
    }

    #[tokio::test]
    async fn a_failed_lookup_still_returns_metadata_rather_than_an_error() {
        // Point the client at a port nothing is listening on. Every request will
        // fail, and that must not stop the caller saving the entry.
        let client = MetadataClient::with_base_urls(
            "http://127.0.0.1:1/mb".into(),
            "http://127.0.0.1:1/ca".into(),
        );

        let result = client
            .lookup_best_effort(&AlbumQuery::new("Sabaton", "Attero Dominatus"))
            .await;

        assert_eq!(result, NOT_FOUND);
        assert_ne!(result.year, Some(0));
    }

    #[test]
    fn both_base_urls_are_substitutable() {
        let client = MetadataClient::with_base_urls(
            "http://localhost:1/mb".into(),
            "http://localhost:1/ca".into(),
        );
        assert_eq!(client.musicbrainz_base_url(), "http://localhost:1/mb");
        assert_eq!(client.cover_art_base_url(), "http://localhost:1/ca");
    }

    #[test]
    fn a_miss_is_an_ordinary_outcome_not_an_error() {
        assert_eq!(NOT_FOUND.cover, None);
        assert_eq!(NOT_FOUND.year, None);
        assert_ne!(NOT_FOUND.year, Some(0));
    }
}
