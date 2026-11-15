// api/edit-file.js
// git's well-known empty tree; GitHub's API returns 404 when asked to read it.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        return res.status(500).json({ error: "GitHub is not configured: GITHUB_TOKEN is missing." });
    }

    // NEW FEATURE: Intercept request to list user repositories automatically
    if (req.method === 'GET' && req.query.fetchRepos === 'true') {
        try {
            // Fetch list sorted by most recently updated projects
            const repoListRes = await fetch('https://api.github.com/user/repos?sort=updated&per_page=50', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!repoListRes.ok) return res.status(repoListRes.status).json({ error: "Could not pull repository directories." });

            const data = await repoListRes.json();
            // Filter out just the clean name info data needed for dropdown rendering
            const cleanRepos = data.map(r => ({ name: r.name, full_name: r.full_name }));
            return res.status(200).json(cleanRepos);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // NEW: List branches for a repo (powers the branch selector)
    if (req.method === 'GET' && req.query.listBranches) {
        try {
            const response = await fetch(`https://api.github.com/repos/${req.query.listBranches}/branches?per_page=100`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) return res.status(response.status).json({ error: "Could not list branches." });
            const data = await response.json();
            return res.status(200).json(data.map(b => ({ name: b.name, protected: !!b.protected })));
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // NEW: Create a brand-new repository
    if (req.method === 'POST' && req.body && req.body.createRepo) {
        const { name, description, isPrivate } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ error: "Repository name is required." });
        }
        try {
            const response = await fetch('https://api.github.com/user/repos', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: name.trim(),
                    description: description || undefined,
                    private: !!isPrivate,
                    auto_init: true // so it has a default branch immediately, ready to push into
                })
            });
            const data = await response.json();
            if (!response.ok) return res.status(response.status).json({ error: data.message || "Could not create repository." });
            return res.status(200).json({ name: data.name, full_name: data.full_name, default_branch: data.default_branch });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // NEW: List contents of a repo path (used by the file browser drawer)
    // Frontend calls: GET ${BACKEND}?listFiles=${encodeURIComponent(`${repo}/contents/${path}`)}
    if (req.method === 'GET' && req.query.listFiles) {
        try {
            const url = `https://api.github.com/repos/${req.query.listFiles}`;
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) return res.status(response.status).json({ error: "Could not list directory contents." });

            const data = await response.json();
            // GitHub returns a single object (not array) if the path points to a file.
            // Normalize to an array so the frontend's `.sort()`/`.map()` always works.
            return res.status(200).json(Array.isArray(data) ? data : [data]);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // NEW: List the ENTIRE repo tree in one request, instead of the
    // frontend recursing directory-by-directory through the Contents API
    // (one round trip per folder, awaited sequentially — slow on repos
    // with lots of nested folders, e.g. Next.js's app/ and components/
    // trees). Uses the same Git Data API recursive-tree call the
    // deleteFolder route below already relies on.
    // Frontend calls: GET ${BACKEND}?listTree=${encodeURIComponent(repo)}&branch=${branch}
    if (req.method === 'GET' && req.query.listTree) {
        try {
            const repo = req.query.listTree;
            const ghHeaders = { 'Authorization': `Bearer ${token}` };

            let branch = req.query.branch;
            if (!branch) {
                const repoInfoRes = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders });
                if (!repoInfoRes.ok) return res.status(repoInfoRes.status).json({ error: "Could not read repository info." });
                const repoInfo = await repoInfoRes.json();
                branch = repoInfo.default_branch;
            }

            const refRes = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${encodeRef(branch)}`, { headers: ghHeaders });
            if (!refRes.ok) return res.status(refRes.status).json({ error: await ghError(refRes, "Could not resolve branch ref.") });
            const refData = await refRes.json();

            const commitRes = await fetch(`https://api.github.com/repos/${repo}/git/commits/${refData.object.sha}`, { headers: ghHeaders });
            if (!commitRes.ok) return res.status(commitRes.status).json({ error: "Could not read base commit." });
            const commitData = await commitRes.json();

            // A repo with zero files (e.g. right after "Delete ALL") points at
            // git's well-known empty tree. GitHub answers 404 "Not Found" for
            // that tree, which used to surface as a "tree not found" error
            // even though the delete itself had worked.
            if (commitData.tree.sha === EMPTY_TREE_SHA) {
                return res.status(200).json({ files: [], truncated: false, branch });
            }

            const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/${commitData.tree.sha}?recursive=1`, { headers: ghHeaders });
            if (!treeRes.ok) return res.status(treeRes.status).json({ error: await ghError(treeRes, "Could not read repository tree.") });
            const treeData = await treeRes.json();

            const files = treeData.tree
                .filter(entry => entry.type === 'blob')
                .map(entry => ({ path: entry.path, sha: entry.sha, size: entry.size }));

            return res.status(200).json({ files, truncated: !!treeData.truncated, branch });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // NEW: Fetch many file blobs by SHA in parallel — the counterpart to
    // bulkCommit for downloads. The "download as zip" button used to call
    // the single-file Contents API once per file, awaited sequentially in
    // a for-loop on the frontend: on a Next.js repo with 500+ files that's
    // 500+ serial round trips and takes forever. Here the frontend sends
    // the full list of {path, sha} (already known from listTree, no extra
    // GitHub calls needed to resolve them) in ONE request, and this route
    // fans the actual GitHub reads out with capped concurrency server-side
    // using the Git Data API's blob endpoint (returns base64 content
    // directly, same encoding the frontend already expects from the
    // Contents API).
    // Frontend calls: POST ${BACKEND} body: { repo, getBlobs: true, files: [{path, sha}, ...] }
    if (req.method === 'POST' && req.body && req.body.getBlobs) {
        const { repo: gbRepo, files: gbFiles } = req.body;
        if (!gbRepo || !Array.isArray(gbFiles) || gbFiles.length === 0) {
            return res.status(400).json({ error: "Missing required parameters: repo or files." });
        }
        if (gbFiles.length > 5000) {
            return res.status(413).json({ error: "Too many files in one request (max 5000)." });
        }
        try {
            const ghHeaders = { 'Authorization': `Bearer ${token}` };
            const CONCURRENCY = 8;
            const results = new Array(gbFiles.length);
            const errors = [];
            let nextIndex = 0;

            async function worker() {
                while (nextIndex < gbFiles.length) {
                    const i = nextIndex++;
                    const f = gbFiles[i];
                    if (!f || !f.path || !f.sha) {
                        errors.push({ path: f && f.path, error: 'Missing path or sha' });
                        continue;
                    }
                    try {
                        const blobRes = await fetch(`https://api.github.com/repos/${gbRepo}/git/blobs/${f.sha}`, { headers: ghHeaders });
                        if (!blobRes.ok) {
                            errors.push({ path: f.path, error: `Blob fetch failed (${blobRes.status})` });
                            continue;
                        }
                        const blobData = await blobRes.json();
                        // Git blobs are always base64 here since we only ever
                        // ask for blobs whose sha came from a tree listing of
                        // real files (GitHub returns 'utf-8' for text blobs
                        // only when requested without matching — in practice
                        // the blobs endpoint returns base64 for binary-safe
                        // transfer; fall back to treating it as-is otherwise).
                        results[i] = { path: f.path, content: blobData.content, encoding: blobData.encoding || 'base64' };
                    } catch (err) {
                        errors.push({ path: f.path, error: err.message });
                    }
                }
            }
            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, gbFiles.length) }, worker));

            const blobs = results.filter(Boolean);
            return res.status(200).json({ blobs, failedCount: errors.length, errors });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // Pulls GitHub's actual error message out of a failed response body
    // instead of letting callers fall back to a generic string. GitHub
    // error bodies are normally { message: "...", errors: [...] }.
    async function ghError(response, fallback) {
        try {
            const body = await response.json();
            if (body && body.message) {
                return `${fallback} (${response.status}): ${body.message}`;
            }
        } catch (_) {
            // body wasn't JSON — fall through to the generic message below.
        }
        return `${fallback} (${response.status})`;
    }

    // Encode a branch name for use inside a /git/ref/heads/<branch> URL
    // while keeping the "/" separators of names like feature/login.
    function encodeRef(branch) {
        return String(branch).split('/').map(encodeURIComponent).join('/');
    }

    // Encode a repo file path for the Contents API (spaces, #, ?, etc.).
    function encodePath(p) {
        return String(p).split('/').map(encodeURIComponent).join('/');
    }

    // Shared by every delete route (single file, folder, selected, all).
    // Removes blobs in ONE commit using the Git Data API:
    //   1. resolve branch -> commit -> tree
    //   2. pick the blobs to remove from the live recursive tree
    //   3. build a new tree (tombstones on base_tree; if GitHub rejects
    //      that, rebuild the full tree minus the removed files)
    //   4. commit it and fast-forward the branch, retrying if someone
    //      pushed in the meantime.
    // Returns { status, body } so each route can just forward it.
    async function commitDeletion({ repo, branchOverride, select, buildMessage }) {
        const ghHeaders = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        };
        const fail = async (r, fallback) => ({ status: r.status, body: { error: await ghError(r, fallback) } });

        let branch = branchOverride;
        if (!branch) {
            const repoInfoRes = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders });
            if (!repoInfoRes.ok) return fail(repoInfoRes, "Could not read repository info.");
            branch = (await repoInfoRes.json()).default_branch;
        }

        let lastRefError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            // Resolve the branch to its CURRENT commit + tree every attempt.
            const refRes = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${encodeRef(branch)}`, { headers: ghHeaders });
            if (!refRes.ok) return fail(refRes, `Could not resolve branch "${branch}"`);
            const commitSha = (await refRes.json()).object.sha;

            const commitRes = await fetch(`https://api.github.com/repos/${repo}/git/commits/${commitSha}`, { headers: ghHeaders });
            if (!commitRes.ok) return fail(commitRes, "Could not read base commit.");
            const baseTreeSha = (await commitRes.json()).tree.sha;

            if (baseTreeSha === EMPTY_TREE_SHA) {
                return { status: 404, body: { error: "This branch has no files left to delete." } };
            }

            const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/${baseTreeSha}?recursive=1`, { headers: ghHeaders });
            if (!treeRes.ok) return fail(treeRes, "Could not read repository tree.");
            const treeData = await treeRes.json();
            if (treeData.truncated) {
                return { status: 422, body: { error: "Repository tree is too large to process in one request." } };
            }

            const removed = select(treeData.tree);
            if (removed.length === 0) {
                return { status: 404, body: { error: "Those files no longer exist on this branch (already deleted?). Reload the file list." } };
            }
            const removedPaths = new Set(removed.map(e => e.path));

            // Attempt A: tombstones on top of the existing tree.
            let newTreeSha = null;
            let tombErr = null;
            const tombRes = await fetch(`https://api.github.com/repos/${repo}/git/trees`, {
                method: 'POST',
                headers: ghHeaders,
                body: JSON.stringify({
                    base_tree: baseTreeSha,
                    tree: removed.map(e => ({ path: e.path, mode: e.mode, type: 'blob', sha: null }))
                })
            });
            if (tombRes.ok) {
                newTreeSha = (await tombRes.json()).sha;
            } else {
                tombErr = await ghError(tombRes, "Could not create new tree.");
            }

            // Attempt B: rebuild the whole tree from the live listing,
            // minus the removed blobs (tree entries are implied by paths).
            if (!newTreeSha) {
                const keep = treeData.tree
                    .filter(e => e.type !== 'tree' && !removedPaths.has(e.path))
                    .map(e => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha }));
                const rebuildRes = await fetch(`https://api.github.com/repos/${repo}/git/trees`, {
                    method: 'POST',
                    headers: ghHeaders,
                    body: JSON.stringify({ tree: keep })
                });
                if (!rebuildRes.ok) {
                    const rebuildErr = await ghError(rebuildRes, "Could not rebuild tree.");
                    return { status: rebuildRes.status, body: { error: `${tombErr} / ${rebuildErr}` } };
                }
                newTreeSha = (await rebuildRes.json()).sha;
            }

            const newCommitRes = await fetch(`https://api.github.com/repos/${repo}/git/commits`, {
                method: 'POST',
                headers: ghHeaders,
                body: JSON.stringify({ message: buildMessage(removed.length), tree: newTreeSha, parents: [commitSha] })
            });
            if (!newCommitRes.ok) return fail(newCommitRes, "Could not create new commit.");
            const newCommit = await newCommitRes.json();

            const updateRefRes = await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${encodeRef(branch)}`, {
                method: 'PATCH',
                headers: ghHeaders,
                body: JSON.stringify({ sha: newCommit.sha })
            });
            if (updateRefRes.ok) {
                return {
                    status: 200,
                    body: {
                        success: true,
                        branch,
                        deletedCount: removed.length,
                        deletedPaths: removed.map(e => e.path),
                        commitSha: newCommit.sha,
                        commit: { sha: newCommit.sha }
                    }
                };
            }
            // 422 = branch moved under us (not a fast-forward). Re-read and retry.
            lastRefError = await ghError(updateRefRes, "Could not update branch ref.");
            if (updateRefRes.status !== 422 && updateRefRes.status !== 409) {
                return { status: updateRefRes.status, body: { error: lastRefError } };
            }
        }
        return { status: 409, body: { error: lastRefError || "Branch kept changing while deleting; try again." } };
    }

    // NEW: Bulk upload — push many files to a repo in ONE commit instead of
    // one PUT (contents API) per file. This is the counterpart to
    // deleteFolder below: it uses the Git Data API to create a blob per
    // file (in parallel, capped concurrency), build a single tree on top
    // of the current HEAD, make one commit, and fast-forward the branch —
    // so uploading 1,000 files costs one commit, not 1,000.
    if (req.method === 'POST' && req.body && req.body.bulkCommit) {
        const { repo: bcRepo, files, message, branch: bcBranchOverride } = req.body;
        if (!bcRepo || !Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: "Missing required parameters: repo or files." });
        }
        // Basic sanity cap — GitHub blobs max out at 100MB each and a single
        // request body this large would be impractical anyway; chunk on the
        // client if you have truly massive payloads.
        if (files.length > 5000) {
            return res.status(413).json({ error: "Too many files in one bulk commit (max 5000)." });
        }

        try {
            const ghHeaders = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            };

            // 1. Resolve the target branch (explicit override, or the repo's
            //    default branch), current commit, and base tree sha.
            let branch = bcBranchOverride;
            if (!branch) {
                const repoInfoRes = await fetch(`https://api.github.com/repos/${bcRepo}`, { headers: ghHeaders });
                if (!repoInfoRes.ok) return res.status(repoInfoRes.status).json({ error: await ghError(repoInfoRes, "Could not read repository info.") });
                const repoInfo = await repoInfoRes.json();
                branch = repoInfo.default_branch;
            }

            const refRes = await fetch(`https://api.github.com/repos/${bcRepo}/git/ref/heads/${branch}`, { headers: ghHeaders });
            if (!refRes.ok) return res.status(refRes.status).json({ error: await ghError(refRes, "Could not resolve branch ref.") });
            const refData = await refRes.json();
            const baseCommitSha = refData.object.sha;

            const commitRes = await fetch(`https://api.github.com/repos/${bcRepo}/git/commits/${baseCommitSha}`, { headers: ghHeaders });
            if (!commitRes.ok) return res.status(commitRes.status).json({ error: await ghError(commitRes, "Could not read base commit.") });
            const commitData = await commitRes.json();
            const baseTreeSha = commitData.tree.sha;

            // 2. Create a blob for every file. Run with capped concurrency
            //    (5 at a time, down from 10 — GitHub's secondary rate limit
            //    triggers on bursts of rapid writes, and 10-wide concurrency
            //    across many back-to-back chunks tripped it in practice) and
            //    retry individual 403 "secondary rate limit" hits with
            //    backoff instead of giving up on the whole chunk immediately.
            const CONCURRENCY = 5;
            const blobResults = new Array(files.length);
            const errors = [];
            let nextIndex = 0;

            function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

            async function createBlobWithRetry(f, attempt = 0) {
                const blobRes = await fetch(`https://api.github.com/repos/${bcRepo}/git/blobs`, {
                    method: 'POST',
                    headers: ghHeaders,
                    body: JSON.stringify({ content: f.content, encoding: 'base64' })
                });
                if (blobRes.ok) return { ok: true, data: await blobRes.json() };

                const isRateLimit = blobRes.status === 403 || blobRes.status === 429;
                if (isRateLimit && attempt < 3) {
                    // Respect Retry-After if GitHub sent one, else back off
                    // 2s / 5s / 12s.
                    const retryAfter = Number(blobRes.headers.get('retry-after'));
                    const waitMs = retryAfter > 0 ? retryAfter * 1000 : [2000, 5000, 12000][attempt];
                    await sleep(waitMs);
                    return createBlobWithRetry(f, attempt + 1);
                }
                return { ok: false, error: await ghError(blobRes, "Blob creation failed") };
            }

            async function worker() {
                while (nextIndex < files.length) {
                    const i = nextIndex++;
                    const f = files[i];
                    if (!f || !f.path || typeof f.content !== 'string') {
                        errors.push({ path: f && f.path, error: 'Missing path or content' });
                        continue;
                    }
                    try {
                        const result = await createBlobWithRetry(f);
                        if (!result.ok) {
                            errors.push({ path: f.path, error: result.error });
                            continue;
                        }
                        blobResults[i] = { path: f.path, mode: '100644', type: 'blob', sha: result.data.sha };
                    } catch (err) {
                        errors.push({ path: f.path, error: err.message });
                    }
                }
            }
            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

            const treeEntries = blobResults.filter(Boolean);
            if (treeEntries.length === 0) {
                return res.status(422).json({ error: "No blobs could be created.", details: errors });
            }

            // 3. Create one new tree on top of the current tree (base_tree
            //    merges these paths in / overwrites existing ones; anything
            //    not mentioned stays untouched).
            const newTreeRes = await fetch(`https://api.github.com/repos/${bcRepo}/git/trees`, {
                method: 'POST',
                headers: ghHeaders,
                body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries })
            });
            if (!newTreeRes.ok) return res.status(newTreeRes.status).json({ error: await ghError(newTreeRes, "Could not create new tree."), details: errors });
            const newTree = await newTreeRes.json();

            // 4. One commit for the whole batch.
            const newCommitRes = await fetch(`https://api.github.com/repos/${bcRepo}/git/commits`, {
                method: 'POST',
                headers: ghHeaders,
                body: JSON.stringify({
                    message: message || `Add ${treeEntries.length} file${treeEntries.length === 1 ? '' : 's'}`,
                    tree: newTree.sha,
                    parents: [baseCommitSha]
                })
            });
            if (!newCommitRes.ok) return res.status(newCommitRes.status).json({ error: await ghError(newCommitRes, "Could not create new commit."), details: errors });
            const newCommit = await newCommitRes.json();

            // 5. Fast-forward the branch ref.
            const updateRefRes = await fetch(`https://api.github.com/repos/${bcRepo}/git/refs/heads/${branch}`, {
                method: 'PATCH',
                headers: ghHeaders,
                body: JSON.stringify({ sha: newCommit.sha })
            });
            if (!updateRefRes.ok) return res.status(updateRefRes.status).json({ error: await ghError(updateRefRes, "Could not update branch ref."), details: errors });

            return res.status(200).json({
                success: true,
                committedCount: treeEntries.length,
                failedCount: errors.length,
                errors,
                commitSha: newCommit.sha
            });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    const { repo, path, content, sha, deleteRepo, deleteFile, deleteFolder, deletePaths, deleteAll, branch: branchOverride, message: customMessage } = req.method === 'GET' ? req.query : req.body;

    // NEW: Delete an entire repository
    if (req.method === 'DELETE' && deleteRepo) {
        try {
            const response = await fetch(`https://api.github.com/repos/${deleteRepo}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) return res.status(response.status).json({ error: "Could not delete repository." });
            return res.status(200).json({ success: true });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // Delete an entire folder in ONE commit.
    if (req.method === 'DELETE' && deleteFolder) {
        if (!repo || !path) {
            return res.status(400).json({ error: "Missing required parameters: repo or path." });
        }
        try {
            const folderPrefix = path.endsWith('/') ? path : `${path}/`;
            const r = await commitDeletion({
                repo,
                branchOverride,
                select: tree => tree.filter(e => e.type === 'blob' && e.path.startsWith(folderPrefix)),
                buildMessage: n => customMessage || `Delete folder ${path} (${n} file${n === 1 ? '' : 's'})`
            });
            return res.status(r.status).json(r.body);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // Delete an explicit set of files, or every file (deleteAll), in ONE commit.
    if (req.method === 'DELETE' && (deletePaths || deleteAll)) {
        if (!repo) {
            return res.status(400).json({ error: "Missing required parameter: repo." });
        }
        if (!deleteAll && (!Array.isArray(deletePaths) || deletePaths.length === 0)) {
            return res.status(400).json({ error: "deletePaths must be a non-empty array." });
        }
        try {
            const targetSet = deleteAll ? null : new Set(deletePaths);
            const r = await commitDeletion({
                repo,
                branchOverride,
                select: tree => tree.filter(e => e.type === 'blob' && (deleteAll || targetSet.has(e.path))),
                buildMessage: n => customMessage || (deleteAll
                    ? `Delete all files (${n} file${n === 1 ? '' : 's'})`
                    : `Delete ${n} file${n === 1 ? '' : 's'}`)
            });
            return res.status(r.status).json(r.body);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // Delete a single file. Goes through the same tree-based path as the
    // bulk routes, so it no longer depends on a (possibly stale) blob sha
    // from the client or on the Contents API's path/branch quirks.
    if (req.method === 'DELETE' && deleteFile) {
        if (!repo || !path) {
            return res.status(400).json({ error: "Missing required parameters: repo or path." });
        }
        try {
            const r = await commitDeletion({
                repo,
                branchOverride,
                select: tree => tree.filter(e => e.type === 'blob' && e.path === path),
                buildMessage: () => customMessage || `Delete ${path}`
            });
            return res.status(r.status).json(r.body);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    if (!repo || !path) {
        return res.status(400).json({ error: "Missing required parameters: repo or path." });
    }

    let url = `https://api.github.com/repos/${repo}/contents/${encodePath(path)}`;
    if (req.method === 'GET' && branchOverride) {
        url += `?ref=${encodeURIComponent(branchOverride)}`;
    }

    try {
        if (req.method === 'GET') {
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) return res.status(response.status).json({ error: "File tracking data absent." });

            const data = await response.json();
            return res.status(200).json(data);
        }

        if (req.method === 'PUT') {
            const bodyData = {
                message: customMessage || "Production Pipeline Update",
                content: content,
                sha: sha || undefined
            };
            if (branchOverride) bodyData.branch = branchOverride;

            const response = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(bodyData)
            });

            const data = await response.json();
            return res.status(200).json(data);
        }
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
