import * as core from "@actions/core"
import { getOctokit, context } from "@actions/github"
import path from "path"
import { promises as fs } from "fs"
import { parse } from "./lcov.js"
import { diff } from "./comment.js"
import { getChangedFiles } from "./get_changes.js"
import { deleteOldComments } from "./delete_old_comments.js"
import { normalisePath } from "./util.js"

const MAX_COMMENT_CHARS = 65536

async function postComment(githubClient, body, options) {
	if (context.eventName === "pull_request") {
		await githubClient.rest.issues.createComment({
			repo: context.repo.repo,
			owner: context.repo.owner,
			issue_number: context.payload.pull_request.number,
			body: body,
		})
	} else if (context.eventName === "push") {
		await githubClient.rest.repos.createCommitComment({
			repo: context.repo.repo,
			owner: context.repo.owner,
			commit_sha: options.commit,
			body: body,
		})
	}
}

async function main() {
	const token = core.getInput("github-token")
	const githubClient = getOctokit(token)
	const workingDir = core.getInput("working-directory") || "./"
	const lcovFile = path.join(
		workingDir,
		core.getInput("lcov-file") || "./coverage/lcov.info",
	)
	const baseFile = core.getInput("lcov-base")
	const shouldFilterChangedFiles =
		core.getInput("filter-changed-files").toLowerCase() === "true"
	const shouldDeleteOldComments =
		core.getInput("delete-old-comments").toLowerCase() === "true"
	const postTo = core.getInput("post-to").toLowerCase()
	const title = core.getInput("title")

	const raw = await fs.readFile(lcovFile, "utf-8").catch((err) => null)
	if (!raw) {
		console.log(`No coverage report found at '${lcovFile}', exiting...`)
		return
	}

	const baseRaw =
		baseFile && (await fs.readFile(baseFile, "utf-8").catch((err) => null))
	if (baseFile && !baseRaw) {
		console.log(`No coverage report found at '${baseFile}', ignoring...`)
	}

	const options = {
		repository: context.payload.repository.full_name,
		prefix: normalisePath(`${process.env.GITHUB_WORKSPACE}/`),
		workingDir,
	}

	if (context.eventName === "pull_request") {
		options.commit = context.payload.pull_request.head.sha
		options.baseCommit = context.payload.pull_request.base.sha
		options.head = context.payload.pull_request.head.ref
		options.base = context.payload.pull_request.base.ref
	} else if (context.eventName === "push") {
		options.commit = context.payload.after
		options.baseCommit = context.payload.before
		options.head = context.ref
	}

	options.shouldFilterChangedFiles = shouldFilterChangedFiles
	options.title = title

	if (shouldFilterChangedFiles) {
		options.changedFiles = await getChangedFiles(githubClient, options, context)
	}

	const lcov = await parse(raw)
	const baselcov = baseRaw && (await parse(baseRaw))
	const body = diff(lcov, baselcov, options).substring(0, MAX_COMMENT_CHARS)

	if (shouldDeleteOldComments) {
		await deleteOldComments(githubClient, options, context)
	}

	switch (postTo) {
		case "comment":
			await postComment(githubClient, body, options)
			break
		case "comment-and-job-summary":
			await postComment(githubClient, body, options)
		case "job-summary":
			await core.summary.addRaw(body).write()
			break
		default:
			core.warning(`Unknown post-to value: '${postTo}'`)
	}
}

main().catch(function (err) {
	console.log(err)
	core.setFailed(err.message)
})
