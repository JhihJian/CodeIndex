package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/sourcegraph/zoekt"
	"github.com/sourcegraph/zoekt/query"
	"github.com/sourcegraph/zoekt/search"
	"hash/crc64"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func main() {
	if len(os.Args) != 5 {
		panic("usage: zoekt-audit INDEX INVENTORY SOURCE EXPECTED_REVISION")
	}
	data, err := os.ReadFile(os.Args[2])
	check(err)
	var inventory []struct {
		Path   string `json:"path"`
		Digest string `json:"digest"`
	}
	check(json.Unmarshal(data, &inventory))
	digests := map[string]string{}
	for _, file := range inventory {
		digests[file.Path] = file.Digest
	}
	index, err := search.NewDirectorySearcher(os.Args[1])
	check(err)
	defer index.Close()
	options := &zoekt.SearchOptions{MaxDocDisplayCount: 200000, MaxMatchDisplayCount: 200000, TotalMaxMatchCount: 200000, ShardMaxMatchCount: 200000}
	names, err := query.Parse("file:.*")
	check(err)
	result, err := index.Search(context.Background(), names, options)
	check(err)
	found := map[string]bool{}
	for _, file := range result.Files {
		found[file.FileName] = true
	}
	missing := []string{}
	for _, file := range inventory {
		if !found[file.Path] {
			missing = append(missing, file.Path)
		}
	}
	options.Whole = true
	skipped, err := index.Search(context.Background(), &query.Substring{Pattern: "NOT-INDEXED: ", Content: true, CaseSensitive: true}, options)
	check(err)
	omitted := []any{}
	omittedPaths := map[string]bool{}
	for _, file := range skipped.Files {
		if strings.HasPrefix(string(file.Content), "NOT-INDEXED: ") {
			omittedPaths[file.FileName] = true
			omitted = append(omitted, map[string]string{"path": file.FileName, "reason": strings.TrimPrefix(string(file.Content), "NOT-INDEXED: ")})
		}
	}
	verified := 0
	mismatches := []string{}
	versions := map[string]bool{}
	versionMismatches := []string{}
	sourceMismatches := []string{}
	table := crc64.MakeTable(crc64.ISO)
	for _, file := range result.Files {
		versions[file.Version] = true
		if file.Version != os.Args[4] {
			versionMismatches = append(versionMismatches, file.FileName)
		}
		content, err := os.ReadFile(filepath.Join(os.Args[3], file.FileName))
		check(err)
		digest := sha256.Sum256(content)
		if hex.EncodeToString(digest[:]) != digests[file.FileName] {
			sourceMismatches = append(sourceMismatches, file.FileName)
		}
		if omittedPaths[file.FileName] {
			continue
		}
		hasher := crc64.New(table)
		_, err = hasher.Write(content)
		check(err)
		if !bytes.Equal(hasher.Sum(nil), file.Checksum) {
			mismatches = append(mismatches, file.FileName)
		}
		verified++
	}
	sort.Strings(missing)
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	check(encoder.Encode(map[string]any{"inputFiles": len(inventory), "indexedInputFiles": len(inventory) - len(missing), "missingFiles": missing, "contentOmitted": omitted, "checksumsChecked": verified, "checksumAlgorithm": "CRC64-ISO", "checksumMismatches": mismatches, "gitVersions": versions, "expectedRevision": os.Args[4], "versionMismatches": versionMismatches, "sourceDigestMismatches": sourceMismatches, "nameSearchStats": result.Stats, "omissionSearchStats": skipped.Stats}))
}
func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
