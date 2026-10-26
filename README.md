# Inkpop

Free manhwa and manga reader for Android, using the public MangaDex API.

## Publish an APK
1. Push this folder to a GitHub repo.
2. Tag a release: `git tag v1.0.0 && git push origin v1.0.0`
3. GitHub Actions builds the APK and attaches it to the repo's Releases page.

## Local dev
`npm install && npm run dev`


## 18+ section
The home screen includes an age-confirmation gate for adult-rated MangaDex listings. It paginates through all titles returned by MangaDex rated erotica/pornographic and requires MangaDex to report English chapter availability. The reader uses English chapters only for these titles; it does not fall back to other languages. Listings and availability depend on MangaDex and may vary by title/region. The age gate is a user-facing confirmation, not identity or age verification.
