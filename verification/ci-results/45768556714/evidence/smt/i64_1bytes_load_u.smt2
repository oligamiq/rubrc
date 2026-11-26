; benchmark generated from python API
(set-info :status unknown)
(declare-fun logical_size () (_ BitVec 32))
(declare-fun addr () (_ BitVec 32))
(declare-fun base () (_ BitVec 32))
(declare-fun physical () (Array (_ BitVec 32) (_ BitVec 8)))
(declare-fun logical () (Array (_ BitVec 32) (_ BitVec 8)))
(assert
 (let ((?x15 ((_ zero_extend 32) logical_size)))
 (bvsle (bvadd ((_ zero_extend 32) addr) (_ bv1 64)) ?x15)))
(assert
 (bvsle (bvadd ((_ zero_extend 32) base) ((_ zero_extend 32) logical_size)) (_ bv4294967296 64)))
(assert
 (let ((?x22 (bvadd addr (_ bv0 32))))
 (let ((?x23 (select logical ?x22)))
 (= ?x23 (select physical (bvadd (bvadd base addr) (_ bv0 32)))))))
(assert
 (let ((?x24 (bvadd base addr)))
(let ((?x32 (select physical ?x24)))
(let ((?x1499 ((_ zero_extend 56) ?x32)))
(let ((?x198 (bvadd (_ bv0 64) (bvmul ((_ zero_extend 56) (select logical (bvadd addr (_ bv0 32)))) (_ bv1 64)))))
(and (distinct ?x198 ?x1499) true))))))
(check-sat)
