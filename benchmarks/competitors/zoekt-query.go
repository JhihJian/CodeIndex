package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"time"

	"github.com/sourcegraph/zoekt"
	"github.com/sourcegraph/zoekt/query"
	"github.com/sourcegraph/zoekt/search"
)

type Question struct {
	Query         string   `json:"query"`
	ExpectedPaths []string `json:"expectedPaths"`
}

func main() {
	if len(os.Args) != 4 {
		panic("usage: zoekt-query INDEX QUESTIONS symbol|text")
	}
	questionsBytes, err := os.ReadFile(os.Args[2])
	must(err)
	var questions []Question
	must(json.Unmarshal(questionsBytes, &questions))
	started := time.Now()
	index, err := search.NewDirectorySearcher(os.Args[1])
	must(err)
	defer index.Close()
	loadMs := float64(time.Since(started).Microseconds()) / 1000
	reports := []any{}
	for _, question := range questions {
		times := []float64{}
		var result *zoekt.SearchResult
		var cold float64
		for n := 0; n < 21; n++ {
			begin := time.Now()
			text := question.Query
			if os.Args[3] == "symbol" {
				text = "sym:" + text
			}
			q, err := query.Parse(text)
			must(err)
			q = query.Simplify(query.Map(q, query.ExpandFileContent))
			result, err = index.Search(context.Background(), q, &zoekt.SearchOptions{MaxDocDisplayCount: 10})
			must(err)
			elapsed := float64(time.Since(begin).Nanoseconds()) / 1e6
			if n == 0 {
				cold = elapsed
			} else {
				times = append(times, elapsed)
			}
		}
		sort.Float64s(times)
		files := []any{}
		hit := false
		for _, file := range result.Files {
			for _, expected := range question.ExpectedPaths {
				if file.FileName == expected {
					hit = true
				}
			}
			lines := []any{}
			for n, line := range file.LineMatches {
				if n == 3 {
					break
				}
				lines = append(lines, map[string]any{"line": line.LineNumber, "source": string(line.Line)})
			}
			files = append(files, map[string]any{"path": file.FileName, "lines": lines})
		}
		reports = append(reports, map[string]any{"query": question.Query, "hitAt10": hit, "coldMs": cold, "medianMs": (times[9] + times[10]) / 2, "files": files, "searchStats": result.Stats})
	}
	repositories, err := index.List(context.Background(), &query.Const{Value: true}, &zoekt.ListOptions{})
	must(err)
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	must(encoder.Encode(map[string]any{"tool": "Zoekt", "loadMs": loadMs, "mode": os.Args[3], "warmup": 1, "repetitions": 20, "rows": reports, "repositories": repositories}))
}
func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
